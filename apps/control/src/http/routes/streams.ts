// Log streams (workspace default + per-service override) and the OpenTelemetry metrics stream.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { one, q, type Row } from '../../db/pool.ts';
import { badRequest, notFound } from '../../lib/core.ts';
import { assertPublicHost, assertPublicUrl } from '../../lib/targets.ts';
import { pushMetrics } from '../../scheduler/streams.ts';
import { workspaceRole } from '../auth.ts';

const LogStream = z.object({
  protocol: z.enum(['syslog-tls', 'syslog-tcp', 'https']),
  endpoint: z.string().trim().min(3).max(2000),
  token: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().default(true),
});

async function validateEndpoint(protocol: string, endpoint: string): Promise<void> {
  if (protocol === 'https') { await assertPublicUrl(endpoint); return; }
  const m = /^\[?([^\]\s/]+?)\]?:(\d{1,5})$/.exec(endpoint);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw badRequest('syslog endpoints are host:port, e.g. logs.example.com:6514');
  await assertPublicHost(m[1]);
}

const logOut = (r: Row) => ({
  id: r.id, workspaceId: r.workspace_id, serviceId: r.service_id, protocol: r.protocol, endpoint: r.endpoint, hasToken: !!r.token_enc,
  enabled: r.enabled, lastError: r.last_error, lastSentAt: r.last_sent_at, createdAt: r.created_at,
});

async function upsertLogStream(workspaceId: string, serviceId: string | null, body: z.infer<typeof LogStream>): Promise<Row> {
  await validateEndpoint(body.protocol, body.endpoint);
  const existing = await one('SELECT * FROM log_streams WHERE workspace_id = $1 AND service_id IS NOT DISTINCT FROM $2', [workspaceId, serviceId]);
  // token: undefined keeps the stored one, null removes it.
  const token = body.token === undefined ? existing?.token_enc ?? null : body.token ? encrypt(body.token) : null;
  if (existing) {
    return (await one('UPDATE log_streams SET protocol = $2, endpoint = $3, token_enc = $4, enabled = $5, last_error = NULL WHERE id = $1 RETURNING *', [existing.id, body.protocol, body.endpoint, token, body.enabled]))!;
  }
  return (await one('INSERT INTO log_streams (id, workspace_id, service_id, protocol, endpoint, token_enc, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id('lgs'), workspaceId, serviceId, body.protocol, body.endpoint, token, body.enabled]))!;
}

async function serviceFor(req: FastifyRequest): Promise<Row> {
  const svc = await one('SELECT id, workspace_id FROM services WHERE id = $1', [(req.params as { id: string }).id]);
  if (!svc) throw notFound('service');
  await workspaceRole(req, svc.workspace_id, 'admin').catch((err) => { throw err.status === 403 ? err : notFound('service'); });
  return svc;
}

export async function streamRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/log-streams', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const rows = await q('SELECT * FROM log_streams WHERE workspace_id = $1 ORDER BY service_id NULLS FIRST', [ws]);
    return { default: rows.find((r) => !r.service_id) ? logOut(rows.find((r) => !r.service_id)!) : null, overrides: rows.filter((r) => r.service_id).map(logOut) };
  });

  app.put('/workspaces/:ws/log-stream', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    return logOut(await upsertLogStream(ws, null, LogStream.parse(req.body)));
  });

  app.delete('/workspaces/:ws/log-stream', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    await q('DELETE FROM log_streams WHERE workspace_id = $1 AND service_id IS NULL', [ws]);
    return reply.status(204).send();
  });

  app.get('/services/:id/log-stream', async (req) => {
    const svc = await serviceFor(req);
    const r = await one('SELECT * FROM log_streams WHERE service_id = $1', [svc.id]);
    return { override: r ? logOut(r) : null };
  });

  app.put('/services/:id/log-stream', async (req) => {
    const svc = await serviceFor(req);
    return logOut(await upsertLogStream(svc.workspace_id, svc.id, LogStream.parse(req.body)));
  });

  app.delete('/services/:id/log-stream', async (req, reply) => {
    const svc = await serviceFor(req);
    await q('DELETE FROM log_streams WHERE service_id = $1', [svc.id]);
    return reply.status(204).send();
  });

  // ---- OpenTelemetry metrics ----

  const metricsOut = (r: Row | null) => r && ({
    endpoint: r.endpoint, headerNames: r.headers_enc ? Object.keys(JSON.parse(decrypt(r.headers_enc))) : [], enabled: r.enabled,
    lastError: r.last_error, lastSentAt: r.last_sent_at, createdAt: r.created_at,
  });

  app.get('/workspaces/:ws/metrics-stream', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    return { stream: metricsOut(await one('SELECT * FROM metrics_streams WHERE workspace_id = $1', [ws])) };
  });

  app.put('/workspaces/:ws/metrics-stream', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const b = z.object({
      endpoint: z.string().trim().url().max(2000),
      headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(2000)).optional(),
      enabled: z.boolean().default(true),
    }).parse(req.body);
    await assertPublicUrl(b.endpoint);
    const prev = await one('SELECT headers_enc FROM metrics_streams WHERE workspace_id = $1', [ws]);
    const headers = b.headers === undefined ? prev?.headers_enc ?? null : encrypt(JSON.stringify(b.headers));
    const row = await one(
      `INSERT INTO metrics_streams (workspace_id, endpoint, headers_enc, enabled) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id) DO UPDATE SET endpoint = EXCLUDED.endpoint, headers_enc = EXCLUDED.headers_enc, enabled = EXCLUDED.enabled, last_error = NULL RETURNING *`,
      [ws, b.endpoint, headers, b.enabled],
    );
    return { stream: metricsOut(row) };
  });

  app.delete('/workspaces/:ws/metrics-stream', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    await q('DELETE FROM metrics_streams WHERE workspace_id = $1', [ws]);
    return reply.status(204).send();
  });

  /** Pushes the current minute right away, to check the endpoint and credentials. */
  app.post('/workspaces/:ws/metrics-stream/test', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const s = await one('SELECT * FROM metrics_streams WHERE workspace_id = $1', [ws]);
    if (!s) throw notFound('metrics stream');
    await pushMetrics(s);
    return { stream: metricsOut(await one('SELECT * FROM metrics_streams WHERE workspace_id = $1', [ws])) };
  });
}
