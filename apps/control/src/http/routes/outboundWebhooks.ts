// Workspace webhooks: NAV POSTs signed JSON (Standard Webhooks headers) to these URLs for workspace events.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { one, q, type Row } from '../../db/pool.ts';
import { notFound } from '../../lib/core.ts';
import { assertPublicUrl } from '../../lib/targets.ts';
import { deliver, eventPayload } from '../../scheduler/notifier.ts';
import { workspaceRole } from '../auth.ts';

/** Event types a webhook can subscribe to (the same kinds as the activity feed). */
export const WEBHOOK_EVENTS = [
  'deploy_live', 'deploy_failed', 'deploy_canceled', 'deploy_waiting_for_checks', 'deploy_skipped_checks_failed', 'service_created', 'service_deleted', 'settings_updated', 'env_updated',
  'plan_changed', 'scaled', 'autoscaled', 'restarted', 'suspended', 'resumed', 'instance_crashed', 'cron_failed',
  'database_created', 'database_available', 'database_updated', 'database_failed', 'database_deleted', 'database_restore_started', 'database_restored',
  'domain_added', 'domain_verified', 'domain_removed', 'certificate_issued', 'env_group_created', 'env_group_updated', 'env_group_deleted',
  'blueprint_created', 'blueprint_synced', 'preview_environment_requested', 'preview_environment_deleted', 'project_created', 'member_added',
];

const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;

function out(r: Row) {
  return { id: r.id, workspaceId: r.workspace_id, name: r.name, url: r.url, events: r.events, enabled: r.enabled, createdAt: r.created_at };
}

async function hookFor(req: FastifyRequest, min: 'viewer' | 'admin' = 'admin'): Promise<Row> {
  const row = await one('SELECT * FROM webhooks WHERE id = $1', [(req.params as { id: string }).id]);
  if (!row) throw notFound('webhook');
  await workspaceRole(req, row.workspace_id, min).catch(() => { throw notFound('webhook'); });
  return row;
}

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().url().max(2000),
  events: z.array(z.string().max(60)).max(60).default([]),
  enabled: z.boolean().default(true),
});

export async function outboundWebhookRoutes(app: FastifyInstance) {
  app.get('/webhook-events', async () => ({ items: WEBHOOK_EVENTS }));

  app.get('/workspaces/:ws/webhooks', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    return { items: (await q('SELECT * FROM webhooks WHERE workspace_id = $1 ORDER BY created_at', [ws])).map(out) };
  });

  app.post('/workspaces/:ws/webhooks', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const body = Body.parse(req.body);
    await assertPublicUrl(body.url);
    const secret = newSecret();
    const row = await one('INSERT INTO webhooks (id, workspace_id, name, url, secret_enc, events, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id('whk'), ws, body.name, body.url, encrypt(secret), body.events, body.enabled]);
    return reply.status(201).send({ webhook: out(row!), secret });
  });

  app.patch('/webhooks/:id', async (req) => {
    const hook = await hookFor(req);
    const body = Body.partial().parse(req.body);
    if (body.url) await assertPublicUrl(body.url);
    const row = await one(
      'UPDATE webhooks SET name = COALESCE($2, name), url = COALESCE($3, url), events = COALESCE($4, events), enabled = COALESCE($5, enabled) WHERE id = $1 RETURNING *',
      [hook.id, body.name ?? null, body.url ?? null, body.events ?? null, body.enabled ?? null],
    );
    return { webhook: out(row!) };
  });

  app.delete('/webhooks/:id', async (req, reply) => {
    const hook = await hookFor(req);
    await q('DELETE FROM webhooks WHERE id = $1', [hook.id]);
    return reply.status(204).send();
  });

  app.get('/webhooks/:id/secret', async (req) => ({ secret: decrypt((await hookFor(req)).secret_enc) }));

  app.post('/webhooks/:id/rotate-secret', async (req) => {
    const hook = await hookFor(req);
    const secret = newSecret();
    await q('UPDATE webhooks SET secret_enc = $2 WHERE id = $1', [hook.id, encrypt(secret)]);
    return { secret };
  });

  /** Sends a sample "test" event now and returns the delivery's outcome. */
  app.post('/webhooks/:id/test', async (req) => {
    const hook = await hookFor(req);
    const payload = eventPayload({ id: 0, kind: 'test', created_at: new Date(), workspace_id: hook.workspace_id, data: { message: 'This is a test event from NAV.' } });
    const d = await one('INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, next_attempt_at) VALUES ($1,NULL,$2,$3, now() + interval \'1 day\') RETURNING *', [hook.id, 'test', payload]);
    await deliver(d!);
    // A test is not retried.
    const r = await one("UPDATE webhook_deliveries SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END WHERE id = $1 RETURNING *", [d!.id]);
    return { delivery: deliveryOut(r!) };
  });

  app.get('/webhooks/:id/deliveries', async (req) => {
    const hook = await hookFor(req);
    const rows = await q('SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT 50', [hook.id]);
    return { items: rows.map(deliveryOut) };
  });

  app.post('/webhooks/:id/deliveries/:deliveryId/retry', async (req) => {
    const hook = await hookFor(req);
    const d = await one("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1 AND webhook_id = $2 RETURNING *", [(req.params as { deliveryId: string }).deliveryId, hook.id]);
    if (!d) throw notFound('delivery');
    return { delivery: deliveryOut(d) };
  });
}

function deliveryOut(r: Row) {
  return {
    id: Number(r.id), eventType: r.event_type, status: r.status, attempts: r.attempts, statusCode: r.status_code, error: r.error,
    durationMs: r.duration_ms, payload: r.payload, nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null, deliveredAt: r.delivered_at, createdAt: r.created_at,
  };
}
