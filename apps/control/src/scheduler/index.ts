// Periodic control loops. Every loop is guarded by a Postgres advisory lock so that running several control
// replicas is safe (only one executes a given loop tick).
import { CronExpressionParser } from 'cron-parser';
import { config } from '@nav/shared/config';
import { id } from '@nav/shared/ids';
import { SERVICE_PLANS } from '@nav/shared';
import { notify, pool, q } from '../db/pool.ts';
import { enqueue, recordEvent } from '../lib/core.ts';
import { markForDeletion } from '../lib/services.ts';
import { ensurePlatformCertificate } from '../lib/platformTls.ts';
import { deleteStoredArtifact } from '@nav/shared/artifacts';
import { snapshotJob } from '../http/routes/snapshots.ts';

async function withLock(key: number, fn: () => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0].ok) return;
    try {
      await fn();
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    c.release();
  }
}

function every(name: string, ms: number, key: number, fn: () => Promise<void>): void {
  const tick = () => withLock(key, fn).catch((err) => console.error(`[scheduler] ${name}:`, err.message));
  setTimeout(tick, 2000);
  setInterval(tick, ms);
}

/** Cron: enqueue a run for each cron service whose next fire time has passed. */
async function cronTick(): Promise<void> {
  const svcs = await q("SELECT s.*, (SELECT max(created_at) FROM runs r WHERE r.service_id = s.id AND r.trigger = 'schedule') AS last_run FROM services s WHERE type = 'cron' AND NOT suspended AND current_deploy_id IS NOT NULL AND status <> 'deleting'");
  const now = new Date();
  for (const s of svcs) {
    const from = s.last_run ? new Date(s.last_run) : new Date(Math.max(new Date(s.updated_at).getTime(), now.getTime() - 60_000));
    let next: Date;
    try {
      next = CronExpressionParser.parse(s.cron_schedule, { tz: 'UTC', currentDate: from }).next().toDate();
    } catch {
      continue;
    }
    if (next > now) continue;
    // Skip if a previous run is still going (no overlapping executions).
    const active = await q("SELECT 1 FROM runs WHERE service_id = $1 AND status IN ('pending','running')", [s.id]);
    if (active.length) continue;
    const runId = id('run');
    await q("INSERT INTO runs (id, service_id, deploy_id, kind, command, trigger, created_at) VALUES ($1,$2,$3,'cron',$4,'schedule',$5)", [runId, s.id, s.current_deploy_id, s.start_command ?? '(image default command)', next]);
    await enqueue('run', { runId, serviceId: s.id });
  }
}

/** Autoscaling: compare recent average CPU / memory utilisation against targets. */
async function autoscaleTick(): Promise<void> {
  const svcs = await q("SELECT * FROM services WHERE (autoscaling->>'enabled')::boolean AND NOT suspended AND current_deploy_id IS NOT NULL AND status = 'live'");
  for (const s of svcs) {
    const plan = SERVICE_PLANS.find((p) => p.id === s.plan) ?? SERVICE_PLANS[1];
    const a = s.autoscaling;
    const recent = await q(
      `SELECT avg(cpu) AS cpu, avg(mem_bytes) AS mem, count(DISTINCT instance_id)::int AS n FROM metrics
       WHERE service_id = $1 AND ts > now() - interval '3 minutes'`,
      [s.id],
    );
    const m = recent[0];
    if (!m || !m.n) continue;
    const cpuPct = (Number(m.cpu) / plan.cpu) * 100;
    const memPct = (Number(m.mem) / (plan.memoryMB * 1048576)) * 100;
    // Desired = ceil(current * utilisation / target), the same proportional rule Kubernetes' HPA uses.
    const wants: number[] = [];
    if (a.targetCpuPercent) wants.push(Math.ceil((s.instance_count * cpuPct) / a.targetCpuPercent));
    if (a.targetMemoryPercent) wants.push(Math.ceil((s.instance_count * memPct) / a.targetMemoryPercent));
    if (!wants.length) continue;
    let desired = Math.min(a.max, Math.max(a.min, ...wants));
    // Scale down gently (one step at a time) and only after a 5 minute cool-down since the last scale event.
    if (desired < s.instance_count) {
      const lastScale = await q("SELECT 1 FROM events WHERE service_id = $1 AND kind = 'autoscaled' AND created_at > now() - interval '5 minutes'", [s.id]);
      if (lastScale.length) continue;
      desired = s.instance_count - 1;
    }
    if (desired === s.instance_count) continue;
    await q('UPDATE services SET instance_count = $2, updated_at = now() WHERE id = $1', [s.id, desired]);
    await enqueue('scale', { serviceId: s.id }, { concurrencyKey: `svc:${s.id}` });
    await recordEvent({ workspaceId: s.workspace_id, serviceId: s.id, kind: 'autoscaled', data: { from: s.instance_count, to: desired, cpuPercent: Math.round(cpuPct), memoryPercent: Math.round(memPct) } });
  }
}

/** Reconciler: services whose running instance count drifted from desired get a scale job. */
async function reconcileTick(): Promise<void> {
  // Instances on nodes that stopped heartbeating are lost; the drift check below replaces them elsewhere.
  const lost = await q(
    `UPDATE instances SET status = 'lost', stopped_at = now()
     WHERE status NOT IN ('stopped','lost') AND node_id IN (SELECT id FROM nodes WHERE last_heartbeat < now() - interval '60 seconds')
     RETURNING id, node_id`,
  );
  if (lost.length) {
    console.log(`[scheduler] ${lost.length} instance(s) lost on unresponsive node(s) ${[...new Set(lost.map((r) => r.node_id))].join(', ')}`);
    await notify('nav_routes');
  }
  const drift = await q(
    `SELECT s.id FROM services s
     WHERE s.type IN ('web','private','worker') AND NOT s.suspended AND s.status IN ('live','failed') AND s.current_deploy_id IS NOT NULL
       AND (SELECT count(*) FROM instances i WHERE i.service_id = s.id AND i.deploy_id = s.current_deploy_id AND i.status IN ('pending','starting','healthy','unhealthy','crashed')) <> s.instance_count
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.concurrency_key = 'svc:' || s.id AND j.status IN ('queued','running'))`,
  );
  for (const s of drift) await enqueue('scale', { serviceId: s.id }, { concurrencyKey: `svc:${s.id}` });

  // Jobs whose agent died mid-run: requeue (or fail) after the lock goes stale.
  await q(
    `UPDATE jobs SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, locked_by = NULL,
       error = COALESCE(error, 'agent stopped responding') , run_at = now()
     WHERE status = 'running' AND locked_by IN (SELECT id FROM nodes WHERE last_heartbeat < now() - interval '60 seconds')`,
  );
  await q(
    `UPDATE jobs SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, locked_by = NULL, run_at = now()
     WHERE status = 'running' AND locked_by LIKE 'control:%' AND locked_at < now() - interval '10 minutes'`,
  );
  // Deploys stuck because their job vanished (e.g. agent crash) are failed so the service is not wedged.
  await q(
    `UPDATE deploys d SET status = 'update_failed', error = 'deploy was interrupted', finished_at = now()
     WHERE status IN ('build_in_progress','pre_deploy_in_progress','update_in_progress') AND started_at < now() - interval '2 minutes'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.payload->>'deployId' = d.id AND j.status IN ('queued','running'))`,
  );
}

/** Retention & housekeeping. */
async function housekeepingTick(): Promise<void> {
  await q(`DELETE FROM logs WHERE ts < now() - make_interval(days => $1)`, [config.logRetentionDays]);
  await q("DELETE FROM metrics WHERE ts < now() - interval '8 days'");
  await q("DELETE FROM http_metrics WHERE minute < now() - interval '8 days'");
  await q("DELETE FROM sessions WHERE expires_at < now()");
  await q("DELETE FROM jobs WHERE status IN ('done','failed','canceled') AND finished_at < now() - interval '3 days'");
  await q("DELETE FROM acme_challenges WHERE created_at < now() - interval '1 day'");
  await q("DELETE FROM instances WHERE status IN ('stopped','lost') AND stopped_at < now() - interval '1 day'");
  await q("DELETE FROM nodes WHERE last_heartbeat < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM databases d WHERE d.node_id = nodes.id)");
  // Expire idle previews.
  const expired = await q(
    `SELECT c.* FROM services c JOIN services p ON p.id = c.parent_service_id
     WHERE c.status <> 'deleting' AND c.updated_at < now() - make_interval(days => COALESCE((p.previews->>'expireAfterDays')::int, 7))
       AND NOT EXISTS (SELECT 1 FROM deploys d WHERE d.service_id = c.id AND d.created_at > now() - make_interval(days => COALESCE((p.previews->>'expireAfterDays')::int, 7)))`,
  );
  for (const p of expired) await markForDeletion(p, null);
}

/** Daily automatic database backups (keep 7) and certificate renewals (30 days before expiry). */
async function dailyTick(): Promise<void> {
  const dbs = await q(
    `SELECT d.id FROM databases d WHERE d.status = 'available' AND d.plan <> 'free'
     AND NOT EXISTS (SELECT 1 FROM db_backups b WHERE b.database_id = d.id AND b.kind = 'automatic' AND b.created_at > now() - interval '23 hours')`,
  );
  for (const d of dbs) {
    const bid = id('bkp');
    await q("INSERT INTO db_backups (id, database_id, kind) VALUES ($1,$2,'automatic')", [bid, d.id]);
    await enqueue('db_backup', { databaseId: d.id, backupId: bid }, { concurrencyKey: `db:${d.id}` });
  }
  await q(
    `DELETE FROM db_backups WHERE kind = 'automatic' AND id IN (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY database_id ORDER BY created_at DESC) AS rn FROM db_backups WHERE kind = 'automatic') x WHERE rn > 7)`,
  );
  // Daily disk snapshots for services with a persistent disk; keep the latest 7 automatic ones.
  const disks = await q("SELECT s.* FROM services s WHERE s.disk IS NOT NULL AND NOT s.suspended AND s.current_deploy_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM disk_snapshots d WHERE d.service_id = s.id AND d.kind = 'automatic' AND d.created_at > now() - interval '23 hours')");
  for (const s of disks) {
    const sid = id('dsn');
    await q("INSERT INTO disk_snapshots (id, service_id, kind) VALUES ($1,$2,'automatic')", [sid, s.id]);
    await snapshotJob('disk_snapshot', s, sid);
  }
  for (const old of await q("SELECT id, store FROM (SELECT id, store, row_number() OVER (PARTITION BY service_id ORDER BY created_at DESC) AS rn FROM disk_snapshots WHERE kind = 'automatic') x WHERE rn > 7")) {
    if (old.store?.key) await deleteStoredArtifact(old.store.key);
    await q('DELETE FROM disk_snapshots WHERE id = $1', [old.id]);
  }
  const renew = await q("SELECT d.id FROM custom_domains d JOIN certificates c ON c.domain = d.domain WHERE c.not_after < now() + interval '30 days'");
  for (const r of renew) await enqueue('issue_cert', { domainId: r.id }, { maxAttempts: 3 });
  // The platform wildcard (*.<apps domain>) is renewed the same way, via DNS-01.
  await ensurePlatformCertificate().catch((err) => console.error('[tls] wildcard renewal check:', (err as Error).message));
  // Re-check unverified domains periodically.
  const pending = await q("SELECT id FROM custom_domains WHERE verification_status <> 'verified' AND created_at > now() - interval '7 days'");
  for (const p of pending) await enqueue('verify_domain', { domainId: p.id });
}

export function startScheduler(): void {
  every('cron', 15_000, 9001, cronTick);
  every('autoscale', 30_000, 9002, autoscaleTick);
  every('reconcile', 15_000, 9003, reconcileTick);
  every('housekeeping', 10 * 60_000, 9004, housekeepingTick);
  every('daily', 60 * 60_000, 9005, dailyTick);
}
