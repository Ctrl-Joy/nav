// Free instance sleep. Free-plan web services with no inbound HTTP traffic for NAV_FREE_SLEEP_MINUTES are spun
// down; the edge holds the next request and signals a wake on the `nav_wake` channel. Waking is idempotent, so
// every control replica may handle the same signal and the edge may repeat it.
import { config } from '@nav/shared/config';
import { listen, notify, one, q } from '../db/pool.ts';
import { activeInstances, stopInstances } from '../agent/cluster.ts';
import { enqueue, log, recordEvent } from './core.ts';

/**
 * Puts idle free web services to sleep. Idle time counts from the latest of: the last request the edge saw, the
 * current deploy going live, the last settings change (which also covers resume) and the last wake.
 */
export async function sleepIdleServices(minutes = config.freeSleepMinutes): Promise<number> {
  if (!(minutes > 0)) return 0;
  const slept = await q(
    `UPDATE services s SET sleeping = true
     WHERE s.type = 'web' AND s.plan = 'free' AND NOT s.sleeping AND NOT s.suspended AND s.status = 'live'
       AND s.current_deploy_id IS NOT NULL
       AND GREATEST(s.last_request_at, s.updated_at, (SELECT d.finished_at FROM deploys d WHERE d.id = s.current_deploy_id))
           < now() - make_interval(mins => $1)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.concurrency_key = 'svc:' || s.id AND j.status IN ('queued','running'))
     RETURNING s.id, s.workspace_id`,
    [minutes],
  );
  for (const s of slept) {
    await stopInstances((await activeInstances(s.id)).map((r) => r.id));
    await log({ serviceId: s.id, stream: 'system', message: `==> Spun down after ${minutes} minutes without traffic; the next request wakes it` });
    await recordEvent({ workspaceId: s.workspace_id, serviceId: s.id, kind: 'service_slept', data: { idleMinutes: minutes } });
  }
  if (slept.length) await notify('nav_routes');
  return slept.length;
}

/** Clears `sleeping` and starts the service's instances. Returns false when it was not asleep. */
export async function wakeService(serviceId: string, opts: { reason: string; actorId?: string | null }): Promise<boolean> {
  const svc = await one('UPDATE services SET sleeping = false, last_request_at = now() WHERE id = $1 AND sleeping RETURNING id, workspace_id', [serviceId]);
  if (!svc) return false;
  await enqueue('scale', { serviceId }, { concurrencyKey: `svc:${serviceId}` });
  await notify('nav_routes');
  await log({ serviceId, stream: 'system', message: opts.reason === 'request' ? '==> Waking up for an incoming request' : '==> Waking up' });
  await recordEvent({ workspaceId: svc.workspace_id, serviceId, actorId: opts.actorId ?? null, kind: 'service_woke', data: { reason: opts.reason } });
  return true;
}

/** Wakes services on the edge's request (LISTEN nav_wake, payload = service id). */
export function startWakeListener(): () => void {
  return listen(['nav_wake'], (_channel, payload) => {
    const serviceId = payload.trim();
    if (!/^[a-z]+_[0-9a-z]{1,64}$/.test(serviceId)) return;
    wakeService(serviceId, { reason: 'request' }).catch((err) => console.error(`[wake] ${serviceId}:`, (err as Error).message));
  });
}
