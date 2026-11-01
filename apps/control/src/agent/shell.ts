// Shell access: a WebSocket endpoint on each agent that opens an interactive shell inside one of its instances.
// Only the control plane connects here (node token); people reach it through the control API, which checks their
// role first. Frames: binary = terminal bytes both ways; text = JSON control messages (resize, ready, exit, error).
import type http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '@nav/shared/config';
import { one } from '../db/pool.ts';
import { localize } from './artifacts.ts';
import type { Ctx } from './handlers.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import { authorized, createAgentServer } from './sandbox/server.ts';
import { baseEnv } from './util.ts';

const IDLE_MS = 30 * 60_000;
const MAX_MS = 4 * 3600_000;

async function openShell(ctx: Ctx, ws: WebSocket, params: URLSearchParams): Promise<void> {
  const fail = (message: string) => { ws.send(JSON.stringify({ type: 'error', message })); ws.close(1011); };
  const instanceId = params.get('instance') ?? '';
  const cols = Math.min(500, Math.max(20, Number(params.get('cols')) || 120));
  const rows = Math.min(200, Math.max(5, Number(params.get('rows')) || 32));
  const entry = ctx.instances.entries.get(instanceId);
  if (!entry?.handle || entry.stopping) return fail('instance is not running on this node');
  if (!ctx.driver.exec) return fail('this driver does not support shell access');
  const svc = await one('SELECT * FROM services WHERE id = $1', [entry.serviceId]);
  const deploy = await one('SELECT * FROM deploys WHERE id = $1', [entry.deployId]);
  if (!svc || !deploy?.artifact) return fail('service not found');

  let cwd: string | null = null;
  let env: Record<string, string> = {};
  if (ctx.driver.name === 'process') {
    const art = await localize(ctx, deploy.artifact);
    cwd = art.kind === 'dir' ? art.path : null;
    const runtime = await ctx.instances.runtimeEnv(svc, deploy, instanceId);
    env = { ...baseEnv(path.join(config.dataDir, 'homes', svc.id)), ...runtime.env, ...(entry.handle.port ? { PORT: String(entry.handle.port) } : {}) };
  }
  const session = await ctx.driver.exec(entry.handle.ref, { cwd, env, cols, rows }).catch((err) => { fail((err as Error).message); return null; });
  if (!session) return;

  let idle = setTimeout(() => ws.close(4000, 'idle'), IDLE_MS);
  const max = setTimeout(() => ws.close(4001, 'session limit'), MAX_MS);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => ws.close(4000, 'idle'), IDLE_MS); };

  ws.send(JSON.stringify({ type: 'ready', tty: session.tty, instanceId, driver: ctx.driver.name }));
  session.onData((chunk) => { if (ws.readyState === ws.OPEN) ws.send(chunk); });
  void session.exited.then((code) => {
    if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ type: 'exit', code })); ws.close(1000); }
  });
  ws.on('message', (data, isBinary) => {
    touch();
    if (isBinary) return session.write(data as Buffer);
    try {
      const m = JSON.parse(String(data));
      if (m.type === 'resize') session.resize(Math.min(500, Math.max(20, m.cols | 0)), Math.min(200, Math.max(5, m.rows | 0)));
      else if (m.type === 'input' && typeof m.data === 'string') session.write(Buffer.from(m.data));
    } catch { /* ignore malformed control frames */ }
  });
  ws.on('close', () => { clearTimeout(idle); clearTimeout(max); session.kill(); });
}

/** Starts the agent's shell (and sandbox) endpoint on the node's private interface; returns the port it listens on. */
export async function startShellServer(ctx: Ctx, sandboxes: SandboxManager | null = null): Promise<number> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const server = createAgentServer(sandboxes, (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://agent');
    if (url.pathname !== '/shell' || !authorized(req.headers.authorization)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void openShell(ctx, ws, url.searchParams).catch((err) => {
      ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      ws.close(1011);
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.NAV_AGENT_PORT ?? 0), config.nodeBindIp, () => resolve());
  });
  return (server.address() as { port: number }).port;
}
