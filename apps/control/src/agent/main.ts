// NAV node agent: claims jobs from the queue and runs builds, deploys, instances, jobs and databases on this node.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '@nav/shared/config';
import { id } from '@nav/shared/ids';
import { one, pool, q } from '../db/pool.ts';
import { enqueue } from '../lib/core.ts';
import { migrate } from '../db/migrate.ts';
import { notify } from '../db/pool.ts';
import { handleDbBackup, handleDbDelete, handleDbProvision, handleDbReconfigure, handleDbRestart, handleDbRestore, handleDbResume, handleDbSuspend, monitorDatabases, recoverDatabases } from './databases.ts';
import { handleBlueprintSync, handleDeleteService, handleDeploy, handleInstanceStart, handleInstanceStop, handleNodeCleanup, handleRestart, handleRun, handleScale, handleStop, type Ctx } from './handlers.ts';
import { CONTROL_JOBS } from '../scheduler/jobs.ts';
import { liveNodes } from './cluster.ts';
import { InstanceManager } from './instances.ts';
import { dockerAvailable, dockerDriver } from './runtime/docker.ts';
import { processDriver } from './runtime/process.ts';
import type { Driver } from './runtime/types.ts';
import { flushLogs, killTree } from './util.ts';

if (!process.env.NAV_MASTER_KEY) {
  console.error('NAV_MASTER_KEY must be set');
  process.exit(1);
}

const MAX_CONCURRENT = Number(process.env.NAV_AGENT_CONCURRENCY ?? 4);
/** Instance start/stop and cleanup jobs run in their own lane: deploys elsewhere wait on them, so they must
 *  never queue behind those deploys. */
const NODE_LANE = ['instance_start', 'instance_stop', 'node_cleanup'];
const NODE_LANE_CONCURRENCY = 32;
const VERSION = '0.1.0';

async function nodeId(): Promise<string> {
  const file = path.join(config.dataDir, 'node-id');
  if (existsSync(file)) return (await readFile(file, 'utf8')).trim();
  const nid = id('node');
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file, nid);
  return nid;
}

async function pickDriver(): Promise<Driver> {
  if (config.driver === 'process') return processDriver();
  if (config.driver === 'docker' || (await dockerAvailable())) {
    if (!(await dockerAvailable())) throw new Error('NAV_DRIVER=docker but the Docker Engine API is not reachable');
    return dockerDriver();
  }
  console.warn('[agent] Docker not available — using the process driver (no container isolation; for development only)');
  return processDriver();
}

type Handler = (ctx: Ctx, payload: any) => Promise<void>;
const HANDLERS: Record<string, Handler> = {
  deploy: handleDeploy,
  scale: handleScale,
  restart: handleRestart,
  stop_service: handleStop,
  delete_service: handleDeleteService,
  run: handleRun,
  blueprint_sync: handleBlueprintSync,
  instance_start: handleInstanceStart,
  instance_stop: handleInstanceStop,
  node_cleanup: handleNodeCleanup,
  db_provision: handleDbProvision,
  db_reconfigure: handleDbReconfigure,
  db_suspend: handleDbSuspend,
  db_resume: handleDbResume,
  db_restart: handleDbRestart,
  db_delete: handleDbDelete,
  db_backup: handleDbBackup,
  db_restore: handleDbRestore,
};

/**
 * Atomically claims the next runnable job of a lane, honouring per-key concurrency. A job naming a node is only
 * claimed by that node; database jobs follow the node that holds the database; a draining node takes no new
 * untargeted work.
 */
async function claim(nid: string, nodeLane: boolean, draining: boolean): Promise<{ id: number; kind: string; payload: any; attempts: number; max_attempts: number } | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(77001)');
    const res = await c.query(
      `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT j.id FROM jobs j WHERE j.status = 'queued' AND j.run_at <= now()
           AND (j.kind = ANY($2)) = $3 AND NOT (j.kind = ANY($5))
           AND (j.node_id = $1 OR (j.node_id IS NULL AND NOT $4))
           AND NOT (j.kind LIKE 'db\\_%' AND EXISTS (SELECT 1 FROM databases d WHERE d.id = j.payload->>'databaseId' AND d.node_id IS NOT NULL AND d.node_id <> $1))
           AND (j.concurrency_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.concurrency_key = j.concurrency_key))
         ORDER BY j.id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [nid, NODE_LANE, nodeLane, draining, CONTROL_JOBS],
    );
    await c.query('COMMIT');
    return res.rows[0] ?? null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function main() {
  await migrate();
  const nid = await nodeId();
  const driver = await pickDriver();
  const instances = new InstanceManager(driver, nid);
  const ctx: Ctx = { driver, instances, nodeId: nid };
  process.env.NAV_ACTIVE_DRIVER = driver.name;

  await q(
    `INSERT INTO nodes (id, hostname, driver, address, capacity, version, last_heartbeat) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (id) DO UPDATE SET hostname = EXCLUDED.hostname, driver = EXCLUDED.driver, address = EXCLUDED.address,
       capacity = EXCLUDED.capacity, version = EXCLUDED.version, last_heartbeat = now()`,
    [nid, os.hostname(), driver.name, config.nodeAddress, { cpus: os.cpus().length, memoryMB: Math.round(os.totalmem() / 1048576) }, VERSION],
  );
  console.log(`[agent] node ${nid} (${os.hostname()}, ${config.nodeAddress}) using the ${driver.name} driver`);

  // Recover after a restart. Process instances from a previous agent are orphans: kill them and let the
  // reconciler start fresh ones. Docker containers are re-adopted.
  // Pending instances keep waiting for their (requeued) start job. Lost ones were already replaced elsewhere
  // while this node was down, so they are stopped rather than adopted.
  const stale = await q("SELECT * FROM instances WHERE node_id = $1 AND status NOT IN ('stopped','pending')", [nid]);
  for (const inst of stale) {
    if (inst.status === 'lost') {
      if (driver.name === 'process' && inst.ref) killTree(Number(inst.ref), true);
      else if (driver.adopt && inst.ref) await (await driver.adopt(inst.ref, () => {}))?.stop(5000);
      await q("UPDATE instances SET status = 'stopped', stopped_at = COALESCE(stopped_at, now()) WHERE id = $1", [inst.id]);
    } else if (driver.name === 'process') {
      if (inst.ref) killTree(Number(inst.ref), true);
      await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE id = $1", [inst.id]);
    } else if (driver.adopt && inst.ref) {
      const handle = await driver.adopt(inst.ref, () => {});
      if (!handle) await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE id = $1", [inst.id]);
      else instances.entries.set(inst.id, { instanceId: inst.id, serviceId: inst.service_id, deployId: inst.deploy_id, workspaceId: '', handle, stopping: false, restarts: inst.restart_count });
    }
  }
  if (stale.length) await notify('nav_routes');
  // Jobs this node was running when it died.
  await q("UPDATE deploys SET status = 'update_failed', error = 'agent restarted during deploy', finished_at = now() WHERE id IN (SELECT payload->>'deployId' FROM jobs WHERE kind = 'deploy' AND status = 'running' AND locked_by = $1)", [nid]);
  await q("UPDATE runs SET status = 'failed', finished_at = now() WHERE id IN (SELECT payload->>'runId' FROM jobs WHERE kind = 'run' AND status = 'running' AND locked_by = $1)", [nid]);
  await q("UPDATE jobs SET status = CASE WHEN attempts < max_attempts AND kind NOT IN ('deploy','run') THEN 'queued' ELSE 'failed' END, locked_by = NULL, error = 'agent restarted' WHERE status = 'running' AND locked_by = $1", [nid]);
  await recoverDatabases(ctx);
  // Process instances do not survive an agent restart: let the cluster bring their services back to size.
  for (const r of await q("SELECT DISTINCT service_id FROM instances WHERE node_id = $1 AND stopped_at > now() - interval '1 minute'", [nid])) {
    await enqueue('scale', { serviceId: r.service_id }, { concurrencyKey: `svc:${r.service_id}` });
  }

  // Heartbeat (also reads back whether an operator is draining this node) + metrics + private networking.
  let draining = false;
  const beat = async () => {
    const row = await one('UPDATE nodes SET last_heartbeat = now() WHERE id = $1 RETURNING draining', [nid]);
    if (row && row.draining !== draining) console.log(`[agent] node ${row.draining ? 'draining: no new work will be placed here' : 'active'}`);
    draining = Boolean(row?.draining);
  };
  await beat();
  setInterval(() => beat().catch(() => {}), 10_000);
  setInterval(() => instances.syncLbs().catch((e) => console.error('[agent] lb sync', e.message)), 3_000);
  setInterval(() => instances.sample().catch((e) => console.error('[agent] sample', e.message)), 15_000);
  setInterval(() => monitorDatabases(ctx).catch(() => {}), 5_000);

  // Job loop: two lanes, each with its own concurrency.
  const running = { work: 0, node: 0 };
  let stopping = false;
  const loop = async (lane: 'work' | 'node') => {
    const max = lane === 'node' ? NODE_LANE_CONCURRENCY : MAX_CONCURRENT;
    while (!stopping && running[lane] < max) {
      const job = await claim(nid, lane === 'node', draining).catch((err) => {
        console.error('[agent] claim failed', err.message);
        return null;
      });
      if (!job) break;
      running[lane]++;
      const handler = HANDLERS[job.kind];
      (async () => {
        const started = Date.now();
        try {
          if (!handler) throw new Error(`unknown job kind ${job.kind}`);
          await handler(ctx, job.payload);
          await q("UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1", [job.id]);
        } catch (err) {
          const retry = job.attempts < job.max_attempts;
          console.error(`[agent] job ${job.id} ${job.kind} failed:`, (err as Error).message);
          await q(
            `UPDATE jobs SET status = $2, error = $3, locked_by = NULL, finished_at = CASE WHEN $2 = 'failed' THEN now() END,
               run_at = now() + make_interval(secs => $4) WHERE id = $1`,
            [job.id, retry ? 'queued' : 'failed', (err as Error).message.slice(0, 2000), 30 * job.attempts],
          );
        } finally {
          running[lane]--;
          if (Date.now() - started > 1000) console.log(`[agent] ${job.kind} #${job.id} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
          void loop(lane);
        }
      })();
    }
  };
  const tick = () => { void loop('node'); void loop('work'); };
  setInterval(tick, 1000);
  tick();

  const shutdown = async () => {
    stopping = true;
    console.log('[agent] shutting down: stopping local instances');
    const affected = new Set([...instances.entries.values()].map((e) => e.serviceId));
    await Promise.all([...instances.entries.values()].map((e) => (driver.name === 'process' ? instances.stop(e, 5000) : Promise.resolve())));
    // Other nodes take over the instances this node just stopped.
    if (driver.name === 'process' && (await liveNodes().catch(() => [])).length > 1) {
      await q('UPDATE nodes SET last_heartbeat = now() - interval \'1 hour\' WHERE id = $1', [nid]).catch(() => {});
      for (const sid of affected) await enqueue('scale', { serviceId: sid }, { concurrencyKey: `svc:${sid}` }).catch(() => {});
    }
    await flushLogs();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[agent] fatal', err);
  process.exit(1);
});
