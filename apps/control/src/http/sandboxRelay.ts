// Relays streaming sandbox execs (and interactive sandbox shells) between a client and the node running the sandbox.
//   GET /api/v1/sandboxes/:id/exec/stream   (WebSocket upgrade)
// Same authentication and origin rules as the instance shell relay; developers and above. Protocol (forwarded
// untouched to the node): the client's first text frame is {type:'start', command?, cwd?, env?, timeoutSeconds?,
// tty?, cols?, rows?}; output arrives as binary frames whose first byte is 1 (stdout) or 2 (stderr); the node ends
// with {type:'exit', code, timedOut}. The command and exit code are audited when the stream ends.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import WebSocket, { type WebSocketServer } from 'ws';
import { nodeToken } from '@nav/shared/artifacts';
import { SANDBOX_LIMITS } from '@nav/shared';
import { one, q } from '../db/pool.ts';
import { authenticate, workspaceRole, type AuthUser } from './auth.ts';
import { redactCommand } from '../lib/sandboxes.ts';
import { liveSandbox } from './routes/sandboxes.ts';
import { writeAudit } from './routes/audit.ts';
import { cookies, reject, sameOrigin } from './shell.ts';

export const SANDBOX_STREAM_PATH = /^\/api\/v1\/sandboxes\/([a-z0-9_]+)\/exec\/stream$/;

export function relaySandboxStream(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, sandboxId: string): void {
  void (async () => {
    const fake = { headers: req.headers, cookies: cookies(req.headers.cookie), user: null, authKind: null } as unknown as FastifyRequest;
    await authenticate(fake).catch(() => {});
    const user = fake.user as AuthUser | null;
    if (!user) return reject(socket, 401, 'Unauthorized');
    if (fake.authKind === 'session' && !sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    const sb = await one('SELECT * FROM sandboxes WHERE id = $1', [sandboxId]);
    if (!sb) return reject(socket, 404, 'Not Found');
    const denied = await workspaceRole(fake, sb.workspace_id, 'developer').then(() => null, (err: { status?: number }) => err.status ?? 404);
    if (denied === 404) return reject(socket, 404, 'Not Found');
    if (denied) return reject(socket, 403, 'Forbidden');
    const node = await liveSandbox(sb).catch(() => null);
    if (!node) return reject(socket, 409, 'Sandbox is not running');

    const upstream = new WebSocket(`ws://${node.address}:${node.agent_port}/sandboxes/${sb.id}/stream`, { headers: { authorization: `Bearer ${nodeToken()}` }, handshakeTimeout: 10_000 });
    upstream.once('error', () => reject(socket, 502, 'Could not reach the node'));
    upstream.once('open', () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        let command: string | null | undefined;
        let cwd: string | null = null;
        let exitCode: number | null = null;
        let timedOut = false;
        let audited = false;
        const audit = () => {
          if (audited || command === undefined) return;
          audited = true;
          void q('UPDATE sandboxes SET exec_count = exec_count + 1, last_exec_at = now() WHERE id = $1', [sb.id]).catch(() => {});
          void writeAudit({
            workspaceId: sb.workspace_id, actorId: user.id, actorEmail: user.email, actorKind: fake.authKind ?? 'session', action: 'sandbox.exec',
            targetType: 'sandboxes', targetId: sb.id, ip: req.socket.remoteAddress ?? null, userAgent: String(req.headers['user-agent'] ?? ''),
            data: { command: command === null ? null : redactCommand(command).slice(0, 4096), cwd, exitCode, timedOut, mode: command === null ? 'shell' : 'stream' },
          });
        };
        upstream.on('message', (data, isBinary) => {
          if (!isBinary) {
            try {
              const m = JSON.parse(String(data));
              if (m.type === 'exit') { exitCode = typeof m.code === 'number' ? m.code : null; timedOut = m.timedOut === true; }
            } catch { /* not ours to judge */ }
          }
          if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
        });
        client.on('message', (data, isBinary) => {
          if (!isBinary && command === undefined) {
            try {
              const m = JSON.parse(String(data));
              if (m.type === 'start') {
                command = typeof m.command === 'string' && m.command ? m.command : null;
                cwd = typeof m.cwd === 'string' && m.cwd ? m.cwd : null;
                if (command && Buffer.byteLength(command) > SANDBOX_LIMITS.maxCommandBytes) {
                  client.send(JSON.stringify({ type: 'error', message: 'command is too long' }));
                  client.close(1008);
                  return;
                }
              }
            } catch { /* forwarded as is */ }
          }
          if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
        });
        const closeBoth = () => { audit(); client.close(); upstream.close(); };
        upstream.on('close', closeBoth);
        client.on('close', closeBoth);
        upstream.on('error', closeBoth);
        client.on('error', closeBoth);
      });
    });
  })().catch(() => reject(socket, 500, 'Internal Server Error'));
}
