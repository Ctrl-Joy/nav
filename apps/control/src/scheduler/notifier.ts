// Outbound notifications: posts deploy outcomes to each workspace's webhook (Slack/Discord-compatible JSON),
// signed with an HMAC so receivers can verify it came from NAV.
import { createHmac } from 'node:crypto';
import { config } from '@nav/shared/config';
import { listen, one } from '../db/pool.ts';

const OUTCOMES: Record<string, 'success' | 'failure'> = { deploy_live: 'success', deploy_failed: 'failure', database_failed: 'failure', cron_failed: 'failure', instance_crashed: 'failure' };

export function startNotifier(): void {
  let lastId = 0;
  const pump = async () => {
    if (!lastId) lastId = Number((await one('SELECT COALESCE(max(id),0) AS id FROM events'))?.id ?? 0);
    const rows = await import('../db/pool.ts').then((m) => m.q('SELECT e.*, s.name AS service_name, n.webhook_url, n.notify_on FROM events e JOIN notification_settings n ON n.workspace_id = e.workspace_id LEFT JOIN services s ON s.id = e.service_id WHERE e.id > $1 ORDER BY e.id LIMIT 200', [lastId]));
    for (const e of rows) {
      lastId = Math.max(lastId, e.id);
      const outcome = OUTCOMES[e.kind];
      if (!outcome || !e.webhook_url || e.notify_on === 'none' || (e.notify_on === 'failure' && outcome !== 'failure')) continue;
      const text = `${outcome === 'success' ? '✅' : '❌'} NAV: ${e.service_name ?? 'resource'} — ${e.kind.replace(/_/g, ' ')}${e.data?.error ? `: ${e.data.error}` : ''}`;
      const body = JSON.stringify({ text, content: text, event: e.kind, serviceId: e.service_id, data: e.data, createdAt: e.created_at, dashboard: config.dashboardUrl });
      const sig = createHmac('sha256', process.env.NAV_MASTER_KEY!).update(body).digest('hex');
      fetch(e.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nav-signature': `sha256=${sig}` }, body, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }
  };
  let timer: NodeJS.Timeout | null = null;
  listen(['nav_changes'], () => {
    if (!timer) timer = setTimeout(() => { timer = null; pump().catch(() => {}); }, 500);
  });
}
