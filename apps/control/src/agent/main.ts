// NAV node agent: claims jobs from the queue and runs builds, deploys, instances, jobs and databases on this node.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '@nav/shared/config';
import { id } from '@nav/shared/ids';
import { pool, q } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { notify } from '../db/pool.ts';
import { handleDbBackup, handleDbDelete, handleDbProvision, handleDbReconfigure, handleDbRestart, handleDbRestore, handleDbResume, handleDbSuspend, monitorDatabases, recoverDatabases } from './databases.ts';
import { handleBlueprintSync, handleDeleteService, handleDeploy, handleIssueCert, handleRestart, handleRun, handleScale, handleStop, handleVerifyDomain, type Ctx } from './handlers.ts';
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
  verify_domain: handleVerifyDomain,
  issue_cert: handleIssueCert,
  blueprint_sync: handleBlueprintSync,
  db_provision: handleDbProvision,
  db_reconfigure: handleDbReconfigure,
  db_suspend: handleDbSuspend,
  db_resume: handleDbResume,
  db_restart: handleDbRestart,
  db_delete: handleDbDelete,
  db_backup: handleDbBackup,
  db_restore: handleDbRestore,
};

/** Atomically claims the next runnable job, honouring per-key concurrency. */
async function claim(nid: string): Promise<{ id: number; kind: string; payload: any; attempts: number; max_attempts: number } | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(77001)');
    const res = await c.query(
      `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT j.id FROM jobs j WHERE j.status = 'queued' AND j.run_at <= now()
           AND (j.concurrency_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.concurrency_key = j.concurrency_key))
         ORDER BY j.id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [nid],
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
    `INSERT INTO nodes (id, hostname, driver, capacity, last_heartbeat) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (id) DO UPDATE SET hostname = EXCLUDED.hostname, driver = EXCLUDED.driver, capacity = EXCLUDED.capacity, last_heartbeat = now()`,
    [nid, os.hostname(), driver.name, { cpus: os.cpus().length, memoryMB: Math.round(os.totalmem() / 1048576) }],
  );
  console.log(`[agent] node ${nid} (${os.hostname()}) using the ${driver.name} driver`);

  // Recover after a restart. Process instances from a previous agent are orphans: kill them and let the
  // reconciler start fresh ones. Docker containers are re-adopted.
  const stale = await q("SELECT * FROM instances WHERE node_id = $1 AND status <> 'stopped'", [nid]);
  for (const inst of stale) {
    if (driver.name === 'process') {
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

  // Heartbeat + metrics.
  setInterval(() => q('UPDATE nodes SET last_heartbeat = now() WHERE id = $1', [nid]).catch(() => {}), 10_000);
  setInterval(() => instances.sample().catch((e) => console.error('[agent] sample', e.message)), 15_000);
  setInterval(() => monitorDatabases(ctx).catch(() => {}), 5_000);

  // Job loop.
  let running = 0;
  let stopping = false;
  const loop = async () => {
    while (!stopping && running < MAX_CONCURRENT) {
      const job = await claim(nid).catch((err) => {
        console.error('[agent] claim failed', err.message);
        return null;
      });
      if (!job) break;
      running++;
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
          running--;
          if (Date.now() - started > 1000) console.log(`[agent] ${job.kind} #${job.id} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
          void loop();
        }
      })();
    }
  };
  setInterval(() => void loop(), 1000);
  void loop();

  const shutdown = async () => {
    stopping = true;
    console.log('[agent] shutting down: stopping local instances');
    await Promise.all([...instances.entries.values()].map((e) => (driver.name === 'process' ? instances.stop(e, 5000) : Promise.resolve())));
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
