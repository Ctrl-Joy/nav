// The agent's sandbox endpoints, served next to the shell endpoint on the node's private interface. Only the
// control plane calls them (node token); people go through the public API, which checks roles, limits and TTLs.
//   GET    /sandboxes                         ids running here, driver
//   POST   /sandboxes                         {spec, snapshot}
//   DELETE /sandboxes/:id
//   POST   /sandboxes/:id/exec                {command, cwd, env, timeoutSeconds, stdin}
//   PUT    /sandboxes/:id/files?path=&mode=   raw body
//   GET    /sandboxes/:id/files?path=         raw body
//   DELETE /sandboxes/:id/files?path=&recursive=1
//   GET    /sandboxes/:id/ls?path=
//   POST   /sandboxes/:id/snapshot            {key}
//   WS     /sandboxes/:id/stream              streaming exec / interactive shell (see handleStream)
import { timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { ARTIFACT_KEY, nodeToken } from '@nav/shared/artifacts';
import { SANDBOX_LIMITS } from '@nav/shared';
import type { SandboxManager } from './manager.ts';
import { SandboxError } from './manager.ts';
import { PathError } from './paths.ts';

const ROUTE = /^\/sandboxes(?:\/([a-z0-9_]+)(?:\/(exec|files|ls|snapshot|stream))?)?$/;

/** Stream frames from the node: first byte 1 = stdout, 2 = stderr, then the bytes. */
export const STDOUT = 1;
export const STDERR = 2;

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new SandboxError(413, 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req, 4 * 1024 * 1024);
  try {
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new SandboxError(400, 'body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.statusCode = status;
    res.end();
    return;
  }
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function strEnv(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, SANDBOX_LIMITS.maxEnvVars)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof val === 'string') out[k] = val;
  }
  return out;
}

/** Handles a sandbox request; false when the path is not a sandbox route. */
export async function handleSandboxRequest(mgr: SandboxManager, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://agent');
  const m = ROUTE.exec(url.pathname);
  if (!m) return false;
  const [, id, action] = m;
  const method = req.method ?? 'GET';
  const rel = url.searchParams.get('path') ?? '';
  try {
    if (!id) {
      if (method === 'GET') return send(res, 200, { ids: mgr.ids(), driver: mgr.driver.name, isolated: mgr.driver.isolated, disabled: mgr.disabledReason }), true;
      if (method === 'POST') {
        const body = await readJson(req);
        const spec = body.spec ?? {};
        if (typeof spec.id !== 'string' || !/^[a-z0-9_]+$/.test(spec.id)) throw new SandboxError(400, 'invalid sandbox id');
        const out = await mgr.create({ ...spec, env: strEnv(spec.env) }, body.snapshot ?? null);
        return send(res, 201, out), true;
      }
    } else if (!action) {
      if (method === 'DELETE') return await mgr.destroy(id), send(res, 204), true;
    } else if (action === 'exec' && method === 'POST') {
      const b = await readJson(req);
      if (typeof b.command !== 'string' || !b.command) throw new SandboxError(400, 'command is required');
      return send(res, 200, await mgr.exec(id, { command: b.command, cwd: typeof b.cwd === 'string' ? b.cwd : '', env: strEnv(b.env), timeoutSeconds: Number(b.timeoutSeconds) || undefined, stdin: typeof b.stdin === 'string' ? b.stdin : null })), true;
    } else if (action === 'files') {
      if (method === 'PUT') {
        const data = await readBody(req, SANDBOX_LIMITS.maxFileBytes);
        const mode = url.searchParams.get('mode');
        return send(res, 200, await mgr.writeFile(id, rel, data, mode && /^[0-7]{3,4}$/.test(mode) ? parseInt(mode, 8) : undefined)), true;
      }
      if (method === 'GET') {
        const file = await mgr.readFile(id, rel);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size });
        await pipeline(file.stream, res);
        return true;
      }
      if (method === 'DELETE') return await mgr.remove(id, rel, url.searchParams.get('recursive') === '1'), send(res, 204), true;
    } else if (action === 'ls' && method === 'GET') {
      return send(res, 200, { items: await mgr.list(id, rel) }), true;
    } else if (action === 'snapshot' && method === 'POST') {
      const { key } = await readJson(req);
      if (typeof key !== 'string' || !ARTIFACT_KEY.test(key)) throw new SandboxError(400, 'invalid snapshot key');
      return send(res, 200, await mgr.snapshot(id, key)), true;
    }
    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    const status = err instanceof SandboxError || err instanceof PathError ? err.status : (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
    if (status === 500) console.error('[agent] sandbox', method, url.pathname, (err as Error).message);
    if (!res.headersSent) send(res, status, { error: (err as Error).message });
    else res.destroy();
  }
  return true;
}

/**
 * Streaming exec over a WebSocket.
 *   client -> {type:'start', command?, cwd?, env?, timeoutSeconds?, tty?, cols?, rows?}   (no command: a shell)
 *   node   -> {type:'started', tty, driver}
 *   node   -> binary frames: [1|2, ...bytes] for stdout / stderr
 *   client -> binary frames (stdin), {type:'stdin', data}, {type:'eof'}, {type:'resize', cols, rows}, {type:'kill'}
 *   node   -> {type:'exit', code, timedOut} then closes; {type:'error', message} on failure
 */
function handleStream(mgr: SandboxManager, id: string, ws: WebSocket): void {
  const fail = (message: string) => { if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ type: 'error', message })); ws.close(1011); } };
  let started = false;
  let proc: Awaited<ReturnType<SandboxManager['start']>> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  ws.on('message', (data, isBinary) => {
    if (isBinary) { proc?.write(data as Buffer); return; }
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === 'start' && !started) {
      started = true;
      const command = typeof msg.command === 'string' && msg.command ? msg.command : null;
      if (command && Buffer.byteLength(command) > SANDBOX_LIMITS.maxCommandBytes) return fail('command is too long');
      const cols = Math.min(500, Math.max(20, msg.cols | 0 || 120));
      const rows = Math.min(200, Math.max(5, msg.rows | 0 || 32));
      void mgr.start(id, { command, cwd: typeof msg.cwd === 'string' ? msg.cwd : '', env: strEnv(msg.env), tty: msg.tty === true || command === null, cols, rows }).then((p) => {
        proc = p;
        if (ws.readyState !== ws.OPEN) { void p.kill(); return; }
        ws.send(JSON.stringify({ type: 'started', tty: p.tty, driver: mgr.driver.name }));
        const forward = (channel: number) => (chunk: Buffer) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([channel]), chunk])); };
        p.onStdout(forward(STDOUT));
        p.onStderr(forward(STDERR));
        if (command) {
          const secs = Math.min(SANDBOX_LIMITS.maxExecTimeoutSeconds, Math.max(1, Number(msg.timeoutSeconds) || SANDBOX_LIMITS.defaultExecTimeoutSeconds));
          timer = setTimeout(() => { timedOut = true; void p.kill(); }, secs * 1000);
        }
        void p.exited.then((code) => {
          if (timer) clearTimeout(timer);
          if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ type: 'exit', code: timedOut ? null : code, timedOut })); ws.close(1000); }
        });
      }, (err) => fail((err as Error).message));
    } else if (msg.type === 'stdin' && typeof msg.data === 'string') proc?.write(Buffer.from(msg.data));
    else if (msg.type === 'eof') proc?.end();
    else if (msg.type === 'resize') proc?.resize(Math.min(500, Math.max(20, msg.cols | 0)), Math.min(200, Math.max(5, msg.rows | 0)));
    else if (msg.type === 'kill') void proc?.kill();
  });
  ws.on('close', () => { if (timer) clearTimeout(timer); void proc?.kill(); });
}

/** Handles a sandbox stream upgrade; false when the path is not one. */
export function handleSandboxUpgrade(mgr: SandboxManager, wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? '/', 'http://agent');
  const m = ROUTE.exec(url.pathname);
  if (!m || m[2] !== 'stream') return false;
  wss.handleUpgrade(req, socket, head, (ws) => handleStream(mgr, m[1], ws));
  return true;
}

/** Only the control plane holds the node token. */
export function authorized(header: string | undefined): boolean {
  const want = Buffer.from(`Bearer ${nodeToken()}`);
  const got = Buffer.from(header ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The agent's private HTTP server: sandbox routes (when this node runs sandboxes) and, through `otherUpgrade`,
 * the instance shell endpoint.
 */
export function createAgentServer(sandboxes: SandboxManager | null, otherUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): http.Server {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const server = http.createServer((req, res) => {
    if (!authorized(req.headers.authorization)) { res.statusCode = 401; res.end(); return; }
    if (!sandboxes) { res.statusCode = 404; res.end(); return; }
    void handleSandboxRequest(sandboxes, req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (sandboxes && authorized(req.headers.authorization) && handleSandboxUpgrade(sandboxes, wss, req, socket, head)) return;
    otherUpgrade(req, socket, head);
  });
  return server;
}
