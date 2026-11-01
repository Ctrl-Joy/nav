// Relays an instance shell between a browser or CLI and the agent of the node running the instance.
//   GET /api/v1/services/:id/shell?instance=<id>&cols=&rows=   (WebSocket upgrade)
// Session-cookie callers must come from the dashboard's origin (WebSockets are not covered by CORS); API keys
// are sent in the Authorization header. Developers and above may open a shell; every session is audited.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { nodeToken } from '@nav/shared/artifacts';
import { config } from '@nav/shared/config';
import { one, q } from '../db/pool.ts';
import { authenticate, atLeast, type AuthUser } from './auth.ts';

const PATH = /^\/api\/v1\/services\/([a-z0-9_]+)\/shell$/;

function reject(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
}

function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = new Set([new URL(config.dashboardUrl).origin, new URL(config.apiPublicUrl).origin]);
  if (req.headers.host) allowed.add(`http://${req.headers.host}`).add(`https://${req.headers.host}`);
  return allowed.has(origin);
}

export function attachShellRelay(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://control');
    const m = PATH.exec(url.pathname);
    if (!m) return reject(socket, 404, 'Not Found');
    void (async () => {
      const fake = { headers: req.headers, cookies: cookies(req.headers.cookie), user: null, authKind: null } as unknown as FastifyRequest;
      await authenticate(fake).catch(() => {});
      const user = fake.user as AuthUser | null;
      if (!user) return reject(socket, 401, 'Unauthorized');
      if (fake.authKind === 'session' && !sameOrigin(req)) return reject(socket, 403, 'Forbidden');
      const svc = await one('SELECT id, workspace_id, name FROM services WHERE id = $1', [m[1]]);
      const member = svc && await one(
        `SELECT m.role, w.require_2fa, u.totp_enabled_at IS NOT NULL AS mfa FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
        [svc.workspace_id, user.id],
      );
      if (!svc || !member) return reject(socket, 404, 'Not Found');
      if (!atLeast(member.role, 'developer') || (member.require_2fa && !member.mfa)) return reject(socket, 403, 'Forbidden');
      const wanted = url.searchParams.get('instance');
      const inst = await one(
        `SELECT i.id, n.address, n.agent_port FROM instances i JOIN nodes n ON n.id = i.node_id
         WHERE i.service_id = $1 AND i.status IN ('healthy','starting','unhealthy') AND ($2::text IS NULL OR i.id = $2)
         ORDER BY (i.status = 'healthy') DESC, i.started_at LIMIT 1`,
        [svc.id, wanted],
      );
      if (!inst) return reject(socket, 409, 'No running instance');
      if (!inst.agent_port) return reject(socket, 502, 'Node does not offer shell access');

      const qs = new URLSearchParams({ instance: inst.id, cols: url.searchParams.get('cols') ?? '120', rows: url.searchParams.get('rows') ?? '32' });
      const upstream = new WebSocket(`ws://${inst.address}:${inst.agent_port}/shell?${qs}`, { headers: { authorization: `Bearer ${nodeToken()}` }, handshakeTimeout: 10_000 });
      upstream.once('error', () => reject(socket, 502, 'Could not reach the node'));
      upstream.once('open', () => {
        wss.handleUpgrade(req, socket, head, (client) => {
          void q(
            `INSERT INTO audit_logs (workspace_id, actor_id, actor_email, actor_kind, action, target_type, target_id, ip, user_agent, data)
             VALUES ($1,$2,$3,$4,'service.shell','services',$5,$6,$7,$8)`,
            [svc.workspace_id, user.id, user.email, fake.authKind, svc.id, req.socket.remoteAddress, String(req.headers['user-agent'] ?? '').slice(0, 300), { instanceId: inst.id }],
          ).catch(() => {});
          upstream.on('message', (data, isBinary) => { if (client.readyState === client.OPEN) client.send(data, { binary: isBinary }); });
          client.on('message', (data, isBinary) => { if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary }); });
          const closeBoth = () => { client.close(); upstream.close(); };
          upstream.on('close', closeBoth);
          client.on('close', closeBoth);
          upstream.on('error', closeBoth);
          client.on('error', closeBoth);
        });
      });
    })().catch(() => reject(socket, 500, 'Internal Server Error'));
  });
}
