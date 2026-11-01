// @nav/sandbox — a small client for NAV Sandboxes: isolated, short-lived environments for running code (for
// example code written by an AI agent) through the API.
//
//   import { NavSandboxes } from '@nav/sandbox';
//   const nav = new NavSandboxes({ host: 'https://nav.example.com', token: process.env.NAV_TOKEN!, workspaceId: 'ws_...' });
//   const sb = await nav.create({ runtime: 'python', ttlSeconds: 600 });
//   await sb.writeFile('main.py', 'print(6 * 7)');
//   const r = await sb.exec('python main.py');   // { exitCode: 0, stdout: '42\n', ... }
//   await sb.delete();
//
// Uses the platform's fetch and WebSocket (Node 24+, browsers, Deno, Bun). Errors are thrown as NavSandboxError.
import type {
  Sandbox, SandboxExecResult, SandboxFileEntry, SandboxNetworkAccess, SandboxPlan, SandboxRuntime, SandboxSnapshot,
} from '@nav/shared';

export type { Sandbox, SandboxExecResult, SandboxFileEntry, SandboxNetworkAccess, SandboxPlan, SandboxRuntime, SandboxSnapshot };

export class NavSandboxError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'NavSandboxError';
    this.status = status;
    this.code = code;
  }
}

export interface ClientOptions {
  /** The NAV control plane, e.g. https://nav.example.com (no /api/v1). */
  host: string;
  /** An API key (Account → API keys). */
  token: string;
  /** Default workspace for create() / list(). */
  workspaceId?: string;
  fetch?: typeof fetch;
}

export interface CreateOptions {
  name?: string;
  /** A preset image (node, python or bash). Ignored when `image` is set. */
  runtime?: SandboxRuntime;
  /** Any image reference (docker driver). */
  image?: string;
  plan?: string;
  /** Seconds until the sandbox is deleted automatically (60 – 86400, default 900). */
  ttlSeconds?: number;
  env?: Record<string, string>;
  networkAccess?: SandboxNetworkAccess;
  /** Start from a snapshot's /workspace (its image and runtime are the defaults). */
  snapshotId?: string;
  workspaceId?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  stdin?: string;
}

export interface StreamOptions extends ExecOptions {
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
}

type Body = { json: unknown } | { raw: Uint8Array } | undefined;

export class NavSandboxes {
  readonly host: string;
  readonly workspaceId: string | undefined;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.host = opts.host.replace(/\/+$/, '');
    this.token = opts.token;
    this.workspaceId = opts.workspaceId;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** @internal */
  async send(method: string, path: string, body?: Body, query?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    let payload: string | Uint8Array | undefined;
    if (body && 'json' in body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body) {
      headers['content-type'] = 'application/octet-stream';
      payload = body.raw;
    }
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await this.fetchImpl(`${this.host}/api/v1${path}${qs}`, { method, headers, body: payload as RequestInit['body'] });
    if (!res.ok) {
      const text = await res.text();
      let code = `http_${res.status}`;
      let message = text || res.statusText;
      try {
        const e = JSON.parse(text).error;
        if (e?.message) { message = e.message; code = e.code ?? code; }
      } catch { /* not JSON */ }
      throw new NavSandboxError(res.status, code, message);
    }
    return res;
  }

  /** @internal */
  async json<T>(method: string, path: string, body?: Body, query?: Record<string, string>): Promise<T> {
    const res = await this.send(method, path, body, query);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private ws(workspaceId?: string): string {
    const ws = workspaceId ?? this.workspaceId;
    if (!ws) throw new NavSandboxError(400, 'workspace_required', 'pass workspaceId to the client or the call');
    return ws;
  }

  async create(opts: CreateOptions = {}): Promise<SandboxHandle> {
    const { workspaceId, ...body } = opts;
    const info = await this.json<Sandbox>('POST', `/workspaces/${this.ws(workspaceId)}/sandboxes`, { json: body });
    return new SandboxHandle(this, info);
  }

  async get(id: string): Promise<SandboxHandle> {
    return new SandboxHandle(this, await this.json<Sandbox>('GET', `/sandboxes/${id}`));
  }

  async list(opts: { status?: 'live' | 'all'; workspaceId?: string } = {}): Promise<Sandbox[]> {
    return (await this.json<{ items: Sandbox[] }>('GET', `/workspaces/${this.ws(opts.workspaceId)}/sandboxes`, undefined, { status: opts.status ?? 'all' })).items;
  }

  async snapshots(opts: { workspaceId?: string; sandboxId?: string } = {}): Promise<SandboxSnapshot[]> {
    const query: Record<string, string> = opts.sandboxId ? { sandboxId: opts.sandboxId } : {};
    return (await this.json<{ items: SandboxSnapshot[] }>('GET', `/workspaces/${this.ws(opts.workspaceId)}/sandbox-snapshots`, undefined, query)).items;
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.json('DELETE', `/sandbox-snapshots/${id}`);
  }

  async plans(): Promise<{ plans: SandboxPlan[]; images: Record<SandboxRuntime, string>; limits: Record<string, number> }> {
    return this.json('GET', '/sandbox-plans');
  }

  /** @internal WebSocket URL + the auth header (Node's WebSocket accepts headers as a non-standard option). */
  socket(path: string): WebSocket {
    const url = `${this.host.replace(/^http/, 'ws')}/api/v1${path}`;
    const WS = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket;
    return new WS(url, { headers: { authorization: `Bearer ${this.token}` } });
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class SandboxHandle {
  info: Sandbox;
  private client: NavSandboxes;

  constructor(client: NavSandboxes, info: Sandbox) {
    this.client = client;
    this.info = info;
  }

  get id(): string {
    return this.info.id;
  }

  async refresh(): Promise<Sandbox> {
    this.info = await this.client.json<Sandbox>('GET', `/sandboxes/${this.id}`);
    return this.info;
  }

  /** Runs a command (through /bin/sh -c) and waits for it. Output is capped at 1 MiB per stream. */
  exec(command: string, opts: ExecOptions = {}): Promise<SandboxExecResult> {
    return this.client.json<SandboxExecResult>('POST', `/sandboxes/${this.id}/exec`, { json: { command, ...opts } });
  }

  /** Runs a command and streams its output as it is produced (no output cap). */
  execStream(command: string, opts: StreamOptions = {}): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const sock = this.client.socket(`/sandboxes/${this.id}/exec/stream`);
    sock.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      const abort = () => { if (sock.readyState === sock.OPEN) sock.send(JSON.stringify({ type: 'kill' })); };
      opts.signal?.addEventListener('abort', abort, { once: true });
      sock.addEventListener('open', () => {
        sock.send(JSON.stringify({ type: 'start', command, cwd: opts.cwd, env: opts.env, timeoutSeconds: opts.timeoutSeconds }));
      });
      sock.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') {
          const bytes = new Uint8Array(e.data as ArrayBuffer);
          (bytes[0] === 2 ? opts.onStderr : opts.onStdout)?.(bytes.subarray(1));
          return;
        }
        const m = JSON.parse(e.data);
        if (m.type === 'started') {
          if (opts.stdin) sock.send(enc.encode(opts.stdin));
          sock.send(JSON.stringify({ type: 'eof' }));
        } else if (m.type === 'exit') {
          done(() => resolve({ exitCode: m.code ?? null, timedOut: m.timedOut === true }));
        } else if (m.type === 'error') {
          done(() => reject(new NavSandboxError(500, 'exec_failed', m.message)));
        }
      });
      sock.addEventListener('close', () => {
        opts.signal?.removeEventListener('abort', abort);
        done(() => reject(new NavSandboxError(502, 'stream_closed', 'the stream closed before the command finished (is the sandbox running, and do you have developer access?)')));
      });
      sock.addEventListener('error', () => {});
    });
  }

  async writeFile(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<{ size: number }> {
    const raw = typeof data === 'string' ? enc.encode(data) : data;
    const query: Record<string, string> = { path };
    if (opts.mode !== undefined) query.mode = opts.mode.toString(8);
    return this.client.json('PUT', `/sandboxes/${this.id}/files`, { raw }, query);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.client.send('GET', `/sandboxes/${this.id}/files`, undefined, { path });
    return new Uint8Array(await res.arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return dec.decode(await this.readFile(path));
  }

  async listFiles(path = ''): Promise<SandboxFileEntry[]> {
    return (await this.client.json<{ items: SandboxFileEntry[] }>('GET', `/sandboxes/${this.id}/ls`, undefined, { path })).items;
  }

  async removeFile(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.client.json('DELETE', `/sandboxes/${this.id}/files`, undefined, { path, recursive: opts.recursive ? '1' : '0' });
  }

  /** Saves /workspace to the artifact store; pass the id as `snapshotId` to create() to start from it. */
  snapshot(opts: { name?: string } = {}): Promise<SandboxSnapshot> {
    return this.client.json<SandboxSnapshot>('POST', `/sandboxes/${this.id}/snapshots`, { json: opts });
  }

  async delete(): Promise<void> {
    await this.client.json('DELETE', `/sandboxes/${this.id}`);
  }
}
