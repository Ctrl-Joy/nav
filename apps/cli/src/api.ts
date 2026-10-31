import type { Page } from '@nav/shared';
import { ApiError, CliError } from './errors.ts';
import { USER_AGENT } from './version.ts';

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface SSEMessage {
  event: string;
  data: string;
  id: string | null;
}

interface SendOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  accept: string;
}

export class ApiClient {
  readonly host: string;
  readonly baseUrl: string;
  readonly token: string | null;

  constructor(opts: { host: string; token: string | null }) {
    this.host = opts.host;
    this.baseUrl = `${opts.host}/api/v1`;
    this.token = opts.token;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  del<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const res = await this.send(method, path, { ...opts, accept: 'application/json' });
    const text = await res.text();
    if (!res.ok) throw apiErrorFrom(res.status, res.statusText, text);
    if (res.status === 204 || text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`unexpected non-JSON response from ${method} ${path}`);
    }
  }

  // Opens a Server-Sent Events stream and yields each message until the server closes it
  // or the signal aborts (the abort surfaces as an AbortError from the consumer's loop).
  async *stream(path: string, query: Query = {}, signal?: AbortSignal): AsyncGenerator<SSEMessage, void, undefined> {
    const res = await this.send('GET', path, { query, signal, accept: 'text/event-stream' });
    if (!res.ok) {
      const text = await res.text();
      throw apiErrorFrom(res.status, res.statusText, text);
    }
    if (!res.body) return;
    yield* parseSSE(readChunks(res.body));
  }

  url(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async send(method: string, path: string, opts: SendOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: opts.accept, 'user-agent': USER_AGENT };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    try {
      return await fetch(this.url(path, opts.query), { method, headers, body, signal: opts.signal });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
      const reason = cause ?? (error instanceof Error ? error.message : String(error));
      throw new CliError(
        `could not reach ${this.host}: ${reason}`,
        'check the server address with nav login --host URL or NAV_HOST',
      );
    }
  }
}

export function apiErrorFrom(status: number, statusText: string, text: string): ApiError {
  let code: string | undefined;
  let message: string | undefined;
  let details: unknown;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null;
    const error = parsed?.error;
    if (error && typeof error === 'object') {
      if (typeof error.code === 'string') code = error.code;
      if (typeof error.message === 'string') message = error.message;
      details = error.details;
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  if (!message) {
    const trimmed = text.trim();
    message = trimmed && !trimmed.startsWith('<') ? trimmed.slice(0, 300) : statusText || `HTTP ${status}`;
  }
  if (!code) code = defaultErrorCode(status);
  return new ApiError(status, code, message, details);
}

function defaultErrorCode(status: number): string {
  switch (status) {
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 422: return 'validation_failed';
    case 429: return 'rate_limited';
    default: return status >= 500 ? 'server_error' : 'http_error';
  }
}

// Fetches every page of a cursor-paginated list endpoint.
export async function listAll<T>(client: ApiClient, path: string, query: Query = {}, maxPages = 100): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res: Page<T> = await client.get<Page<T>>(path, { ...query, limit: 100, cursor });
    items.push(...res.items);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return items;
}

export async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface SSEState {
  event: string;
  data: string[];
  id: string | null;
}

// Feeds one line (without its terminator) into the SSE state; returns a message when a blank
// line dispatches a complete event.
function applySSELine(state: SSEState, line: string): SSEMessage | null {
  if (line === '') {
    const dispatch = state.data.length > 0;
    const message = dispatch
      ? { event: state.event || 'message', data: state.data.join('\n'), id: state.id }
      : null;
    state.event = '';
    state.data = [];
    return message;
  }
  if (line.startsWith(':')) return null;
  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  switch (field) {
    case 'event':
      state.event = value;
      break;
    case 'data':
      state.data.push(value);
      break;
    case 'id':
      if (!value.includes('\0')) state.id = value;
      break;
    default:
      // "retry" and unknown fields are ignored.
      break;
  }
  return null;
}

// Parses a text/event-stream body. Chunks may split lines and UTF-8 sequences anywhere.
// Per the EventSource spec, an event still pending at end of stream is discarded.
export async function* parseSSE(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<SSEMessage, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  const state: SSEState = { event: '', data: [], id: null };
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const message = applySSELine(state, line);
      if (message) yield message;
      newline = buffer.indexOf('\n');
    }
  }
}
