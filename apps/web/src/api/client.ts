import type { ApiError } from '@nav/shared';

export const API_BASE = '/api/v1';

/** Typed error thrown for every non-2xx API response (and for network failures, status 0). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isApiError(e: unknown): e is ApiRequestError {
  return e instanceof ApiRequestError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /** When true, a 401 does not trigger the global "go to login" handler. */
  skipAuthRedirect?: boolean;
}

let unauthorizedHandler: (() => void) | null = null;

/** Registered by the app root: called on any 401 (except opted-out requests). */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        if (v.length) qs.set(k, v.join(','));
      } else qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

function isApiErrorBody(v: unknown): v is ApiError {
  if (typeof v !== 'object' || v === null || !('error' in v)) return false;
  const err = (v as { error: unknown }).error;
  return typeof err === 'object' && err !== null && 'message' in err;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-NAV-CSRF'] = '1';
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'network_error', 'Could not reach the NAV control plane. Is it running?');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !opts.skipAuthRedirect) unauthorizedHandler?.();
    if (isApiErrorBody(data)) {
      throw new ApiRequestError(res.status, data.error.code ?? 'error', data.error.message, data.error.details);
    }
    if (res.status >= 502 && res.status <= 504) {
      throw new ApiRequestError(res.status, 'unavailable', `The NAV control plane is unavailable (${res.status}). Is it running?`);
    }
    throw new ApiRequestError(res.status, `http_${res.status}`, res.statusText || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T = void>(path: string, query?: Query) => request<T>(path, { method: 'DELETE', query }),
};
