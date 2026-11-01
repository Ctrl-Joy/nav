// Outbound notifications for workspace events:
//  - the workspace's Slack/Discord-compatible webhook (deploy outcomes, failures),
//  - email to members who have not opted out,
//  - signed webhooks (Standard Webhooks format) with retries and a delivery history.
import { createHmac } from 'node:crypto';
import { config } from '@nav/shared/config';
import { decrypt } from '@nav/shared/crypto';
import { listen, one, q, type Row } from '../db/pool.ts';
import { layout, sendMail } from '../lib/mail.ts';
import { assertPublicUrl } from '../lib/targets.ts';

const OUTCOMES: Record<string, 'success' | 'failure'> = { deploy_live: 'success', deploy_failed: 'failure', database_failed: 'failure', cron_failed: 'failure', instance_crashed: 'failure' };
/** Retry schedule after a failed delivery (then the delivery is marked failed). */
const BACKOFF_S = [10, 60, 300, 1800, 7200];

export function eventPayload(e: Row): Record<string, unknown> {
  return {
    id: `evt_${e.id}`,
    type: e.kind,
    timestamp: new Date(e.created_at).toISOString(),
    workspaceId: e.workspace_id,
    serviceId: e.service_id ?? null,
    databaseId: e.database_id ?? null,
    data: e.data ?? {},
  };
}

/** Standard Webhooks signature: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" with the whsec_ secret. */
export function sign(secret: string, msgId: string, ts: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${msgId}.${ts}.${body}`).digest('base64')}`;
}

async function slack(e: Row, outcome: 'success' | 'failure'): Promise<void> {
  const n = await one('SELECT webhook_url, notify_on FROM notification_settings WHERE workspace_id = $1', [e.workspace_id]);
  if (!n?.webhook_url || n.notify_on === 'none' || (n.notify_on === 'failure' && outcome !== 'failure')) return;
  const text = `${outcome === 'success' ? '✅' : '❌'} NAV: ${e.service_name ?? 'resource'} — ${e.kind.replace(/_/g, ' ')}${e.data?.error ? `: ${e.data.error}` : ''}`;
  const body = JSON.stringify({ text, content: text, event: e.kind, serviceId: e.service_id, data: e.data, createdAt: e.created_at, dashboard: config.dashboardUrl });
  const sig = createHmac('sha256', process.env.NAV_MASTER_KEY!).update(body).digest('hex');
  await fetch(n.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nav-signature': `sha256=${sig}` }, body, signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

async function email(e: Row, outcome: 'success' | 'failure'): Promise<void> {
  const n = await one('SELECT email_notify_on FROM notification_settings WHERE workspace_id = $1', [e.workspace_id]);
  const mode = n?.email_notify_on ?? 'failure';
  if (mode === 'none' || (mode === 'failure' && outcome !== 'failure')) return;
  const to = (await q(
    `SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 AND m.role IN ('owner','admin','developer') AND u.email_notifications`,
    [e.workspace_id],
  )).map((r) => r.email);
  if (!to.length) return;
  const what = e.kind.replace(/_/g, ' ');
  const name = e.service_name ?? e.database_name ?? 'A resource';
  const link = e.service_id ? `${config.dashboardUrl}/w/${e.workspace_id}/services/${e.service_id}` : `${config.dashboardUrl}/w/${e.workspace_id}`;
  const body = layout(`${name}: ${what}`, [
    outcome === 'failure' ? `${name} reported a problem: ${what}.` : `${name}: ${what}.`,
    ...(e.data?.error ? [`Error: ${String(e.data.error).slice(0, 500)}`] : []),
  ], { label: 'Open in NAV', url: link });
  await sendMail({ to, subject: `${outcome === 'failure' ? '[Failed] ' : ''}${name}: ${what}`, ...body });
}

/** Queues a delivery for every enabled webhook of the workspace that subscribes to this event type. */
async function enqueueWebhooks(e: Row): Promise<void> {
  const hooks = await q('SELECT id FROM webhooks WHERE workspace_id = $1 AND enabled AND (cardinality(events) = 0 OR $2 = ANY(events))', [e.workspace_id, e.kind]);
  for (const h of hooks) {
    await q('INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [h.id, e.id, e.kind, eventPayload(e)]);
  }
}

/** Sends one delivery and records the outcome; failures are retried on the backoff schedule. */
export async function deliver(d: Row): Promise<void> {
  const hook = await one('SELECT * FROM webhooks WHERE id = $1', [d.webhook_id]);
  if (!hook) return;
  const body = JSON.stringify(d.payload);
  const msgId = `msg_${d.id}`;
  const ts = Math.floor(Date.now() / 1000);
  const started = Date.now();
  let code: number | null = null;
  let error: string | null = null;
  try {
    await assertPublicUrl(hook.url);
    const res = await fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'NAV-Webhooks/1.0', 'webhook-id': msgId, 'webhook-timestamp': String(ts), 'webhook-signature': sign(decrypt(hook.secret_enc), msgId, ts, body) },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    code = res.status;
    await res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }
  const attempts = d.attempts + 1;
  const ms = Date.now() - started;
  if (!error) {
    await q("UPDATE webhook_deliveries SET status = 'succeeded', attempts = $2, status_code = $3, error = NULL, duration_ms = $4, delivered_at = now() WHERE id = $1", [d.id, attempts, code, ms]);
  } else if (attempts > BACKOFF_S.length) {
    await q("UPDATE webhook_deliveries SET status = 'failed', attempts = $2, status_code = $3, error = $4, duration_ms = $5 WHERE id = $1", [d.id, attempts, code, error, ms]);
  } else {
    await q('UPDATE webhook_deliveries SET attempts = $2, status_code = $3, error = $4, duration_ms = $5, next_attempt_at = now() + make_interval(secs => $6) WHERE id = $1', [d.id, attempts, code, error, ms, BACKOFF_S[attempts - 1]]);
  }
}

export function startNotifier(): void {
  // Start after the newest event at boot (read now, not on the first wake-up, which would skip that event).
  let lastId: number | null = null;
  const ready = one('SELECT COALESCE(max(id),0) AS id FROM events').then((r) => { lastId = Number(r?.id ?? 0); });
  const pump = async () => {
    await ready;
    if (lastId === null) return;
    const rows = await q(
      `SELECT e.*, s.name AS service_name, d.name AS database_name FROM events e
       LEFT JOIN services s ON s.id = e.service_id LEFT JOIN databases d ON d.id = e.database_id
       WHERE e.id > $1 ORDER BY e.id LIMIT 200`,
      [lastId],
    );
    for (const e of rows) {
      lastId = Math.max(lastId, Number(e.id));
      await enqueueWebhooks(e).catch((err) => console.error('[notifier] webhooks:', err.message));
      const outcome = OUTCOMES[e.kind];
      if (!outcome) continue;
      void slack(e, outcome);
      void email(e, outcome).catch((err) => console.error('[notifier] email:', err.message));
    }
  };
  let timer: NodeJS.Timeout | null = null;
  listen(['nav_changes'], () => {
    if (!timer) timer = setTimeout(() => { timer = null; pump().catch(() => {}); }, 500);
  });
  // Not every event is announced on nav_changes; sweep regularly so none waits for the next one that is.
  setInterval(() => { if (!timer) pump().catch(() => {}); }, 3000);

  // Delivery worker: due deliveries, claimed so that several control replicas never send one twice.
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await q(
        `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '2 minutes'
         WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
      );
      await Promise.all(due.map((d) => deliver(d).catch(() => {})));
    } catch (err) {
      console.error('[notifier] deliveries:', (err as Error).message);
    } finally {
      busy = false;
    }
  }, 2000);
}
