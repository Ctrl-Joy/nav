// Advanced managed-Postgres features on the node holding a database: streaming read replicas, high availability
// (hot standby + automatic failover), PgBouncer connection pooling, major version upgrades and table repacks.
// Process driver: clusters under <dataDir>/databases/<id>/ (replicas/<rid>, pooler/). Docker driver: containers
// built by lib/pgcommands.ts.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { decrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { DATABASE_PLANS } from '@nav/shared';
import { one, q, type Row } from '../db/pool.ts';
import { changed, enqueue, recordEvent } from '../lib/core.ts';
import {
  clusterVersion, hasExtension, hasTool, initCluster, isFullInstall, isRunning, pgInstalls, pgServerInstall, pgTool, reloadCluster, runPg, startCluster,
  stopCluster, stripAutoConf, toolPath, writeConfig, type ClusterSpec,
} from '../lib/pgcluster.ts';
import {
  dockerEnableReplicationCmd, dockerPoolerContainer, dockerPostgresContainer, dockerReplicaContainer, dockerUpgradeCommands, globalsStatements,
  pgbouncerConfig, poolSizeFor, slotName, standbyConninfo, PGBOUNCER_IMAGE, PGBOUNCER_MISSING,
} from '../lib/pgcommands.ts';
import {
  archiveDir, dataDir, dbLog, dbRoot, dockerEnsureNetwork, dockerPullImage, EMPTY_DIRS, pgConnect, queueBaseBackup, setStatus, skipLive, spec,
  waitForPostgres, walkDir,
} from './databases.ts';
import type { Ctx } from './handlers.ts';
import { freePort, isWin, killTree, pipeLines, sleep } from './util.ts';

const execFileP = promisify(execFile);
export const replicaDir = (dbId: string, rid: string) => path.join(dbRoot(dbId), 'replicas', rid);
const poolerDir = (dbId: string) => path.join(dbRoot(dbId), 'pooler');
const planOf = (db: Row) => DATABASE_PLANS.find((p) => p.id === db.plan) ?? DATABASE_PLANS[1];
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function docker() {
  const Docker = (await import('dockerode')).default;
  return new Docker();
}

async function opUpdate(opId: string | undefined, status: string, data: Record<string, unknown> = {}, error: string | null = null): Promise<void> {
  if (!opId) return;
  await q(`UPDATE db_operations SET status = $2, data = data || $3, error = $4, finished_at = CASE WHEN $2 IN ('completed','failed') THEN now() END WHERE id = $1`, [opId, status, data, error]);
}

async function replicaStatus(r: Row, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const keys = Object.keys(extra);
  await q(`UPDATE db_replicas SET status = $2${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')}, updated_at = now() WHERE id = $1`, [r.id, status, ...keys.map((k) => extra[k])]);
}

// --- Replicas --------------------------------------------------------------------------------------

async function replicaSpec(db: Row, r: Row, port: number): Promise<ClusterSpec> {
  const base = await spec(db, port, { dataDir: replicaDir(db.id, r.id) });
  return {
    ...base,
    // The HA standby archives into the database's archive once promoted; read replicas never archive.
    archiveDir: r.role === 'standby' ? base.archiveDir : undefined,
    standby: { conninfo: standbyConninfo({ host: '127.0.0.1', port: db.port, user: db.db_user, password: base.password, applicationName: r.id }), slot: r.slot_name },
  };
}

/** Online clone without pg_basebackup: pg_backup_start + file copy + backup_label; WAL comes over the slot. */
async function copyClone(c: import('pg').Client, db: Row, dir: string): Promise<void> {
  await c.query("SELECT pg_backup_start('nav-clone', true)");
  try {
    await mkdir(dir, { recursive: true });
    await walkDir(dataDir(db.id), '', skipLive, (r) => mkdir(path.join(dir, r), { recursive: true }).then(() => {}), (r, buf) => writeFile(path.join(dir, r), buf, { mode: 0o600 }));
    const stop = await c.query('SELECT labelfile FROM pg_backup_stop(false)');
    await writeFile(path.join(dir, 'backup_label'), stop.rows[0].labelfile);
  } catch (err) {
    await c.query('SELECT pg_backup_stop(false)').catch(() => {});
    throw err;
  }
  for (const d of EMPTY_DIRS) await mkdir(path.join(dir, d), { recursive: true });
}

async function dropSlot(db: Row, slot: string): Promise<void> {
  const c = await pgConnect(db, db.port, 'postgres', 3000).catch(() => null);
  if (!c) return;
  try {
    for (let i = 0; i < 10; i++) {
      const r = await c.query('SELECT active FROM pg_replication_slots WHERE slot_name = $1', [slot]);
      if (!r.rowCount) return;
      if (!r.rows[0].active) {
        await c.query('SELECT pg_drop_replication_slot($1)', [slot]);
        return;
      }
      await sleep(1000);
    }
  } finally {
    await c.end().catch(() => {});
  }
}

/** Builds (or rebuilds) a replica / standby from the primary and starts it streaming. */
export async function createReplica(ctx: Ctx, db: Row, r: Row): Promise<boolean> {
  const log = (m: string, level = 'info') => dbLog(db, `[${r.role === 'standby' ? 'standby' : `replica ${r.name}`}] ${m}`, level);
  await replicaStatus(r, 'creating', { error: null });
  await changed(db.workspace_id, 'database', db.id);
  try {
    if (ctx.driver.name === 'docker') await dockerCreateReplica(db, r, log);
    else {
      const port = r.port ?? (await freePort());
      const dir = replicaDir(db.id, r.id);
      await stopCluster(dir, 'immediate').catch(() => {});
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      const c = await pgConnect(db, db.port, 'postgres');
      try {
        await c.query('SELECT pg_create_physical_replication_slot($1, true) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1)', [r.slot_name]);
        const version = (await clusterVersion(dataDir(db.id))) ?? db.pg_version;
        const tool = await pgTool('pg_basebackup', version);
        if (tool) {
          log('==> Cloning the primary with pg_basebackup');
          const res = await runPg(tool, ['-h', '127.0.0.1', '-p', String(db.port), '-U', db.db_user, '-D', dir, '-X', 'stream', '-S', r.slot_name, '-R', '-c', 'fast', '-w'], { env: { PGPASSWORD: decrypt(db.password_enc) } });
          if (res.code !== 0) throw new Error(`pg_basebackup failed: ${res.out.slice(-600)}`);
        } else {
          log('==> Cloning the primary with an online base backup (pg_basebackup is not installed)');
          await copyClone(c, db, dir);
        }
      } finally {
        await c.end().catch(() => {});
      }
      await stripAutoConf(dir, ['primary_conninfo', 'primary_slot_name']);
      await rm(path.join(dir, 'server.log'), { force: true });
      await writeFile(path.join(dir, 'standby.signal'), '');
      const s = await replicaSpec(db, r, port);
      await writeConfig(s);
      await startCluster(s, (l) => log(l));
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        const rc = await pgConnect(db, port, 'postgres', 2000).catch(() => null);
        if (rc) {
          ok = (await rc.query('SELECT pg_is_in_recovery() AS r')).rows[0].r === true;
          await rc.end().catch(() => {});
        }
        if (!ok) await sleep(1000);
      }
      if (!ok) throw new Error('the replica did not start in standby mode');
      await replicaStatus(r, 'available', { node_id: ctx.nodeId, host: '127.0.0.1', port });
    }
    log(`==> ${r.role === 'standby' ? 'Standby' : 'Replica'} is streaming from the primary`);
    await changed(db.workspace_id, 'database', db.id);
    return true;
  } catch (err) {
    log(`==> Failed: ${(err as Error).message}`, 'error');
    await replicaStatus(r, 'failed', { error: (err as Error).message.slice(0, 2000) });
    // A slot nobody consumes would retain WAL until the disk fills.
    if (ctx.driver.name !== 'docker') {
      await stopCluster(replicaDir(db.id, r.id), 'immediate').catch(() => {});
      await dropSlot(db, r.slot_name);
    }
    await changed(db.workspace_id, 'database', db.id);
    return false;
  }
}

async function removeReplicaFiles(ctx: Ctx, db: Row, r: Row): Promise<void> {
  if (ctx.driver.name === 'docker') {
    const d = await docker();
    await d.getContainer(`nav-dbr-${r.id}`).remove({ force: true }).catch(() => {});
    await d.getVolume(`nav-dbr-${r.id}`).remove().catch(() => {});
  } else {
    await stopCluster(replicaDir(db.id, r.id), 'immediate').catch(() => {});
    await rm(replicaDir(db.id, r.id), { recursive: true, force: true }).catch(() => {});
  }
  await dropSlot(db, r.slot_name);
}

export async function handleDbReplicaCreate(ctx: Ctx, payload: { databaseId: string; replicaId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  const r = await one('SELECT * FROM db_replicas WHERE id = $1', [payload.replicaId]);
  if (!db || !r || r.status === 'deleting') return;
  if (db.status !== 'available') {
    await replicaStatus(r, 'failed', { error: `database is ${db.status}` });
    return;
  }
  if (await createReplica(ctx, db, r)) await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_replica_created', data: { replicaId: r.id, name: r.name, role: r.role } });
}

export async function handleDbReplicaDelete(ctx: Ctx, payload: { databaseId: string; replicaId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  const r = await one('SELECT * FROM db_replicas WHERE id = $1', [payload.replicaId]);
  if (!db || !r) return;
  await removeReplicaFiles(ctx, db, r);
  await q('DELETE FROM db_replicas WHERE id = $1', [r.id]);
  dbLog(db, `==> ${r.role === 'standby' ? 'Standby' : `Replica ${r.name}`} removed`);
  await changed(db.workspace_id, 'database', db.id);
}

export async function stopReplicas(ctx: Ctx, db: Row, remove = false): Promise<void> {
  for (const r of await q('SELECT * FROM db_replicas WHERE database_id = $1', [db.id])) {
    if (remove) await removeReplicaFiles(ctx, db, r);
    else if (ctx.driver.name === 'docker') await (await docker()).getContainer(`nav-dbr-${r.id}`).stop().catch(() => {});
    else await stopCluster(replicaDir(db.id, r.id)).catch(() => {});
  }
}

export async function startReplicas(ctx: Ctx, db: Row): Promise<void> {
  for (const r of await q("SELECT * FROM db_replicas WHERE database_id = $1 AND status = 'available'", [db.id])) {
    if (ctx.driver.name === 'docker') await (await docker()).getContainer(`nav-dbr-${r.id}`).start().catch(() => {});
    else if (!(await isRunning(replicaDir(db.id, r.id)))) await startCluster(await replicaSpec(db, r, r.port), (l) => dbLog(db, `[replica ${r.name}] ${l}`)).catch((err) => dbLog(db, `==> Replica ${r.name} failed to start: ${err.message}`, 'error'));
  }
}

/** Physical replicas cannot follow a primary whose WAL history was rewritten (restore, upgrade): re-clone them. */
export async function rebuildReplicas(ctx: Ctx, db: Row): Promise<void> {
  const fresh = await one('SELECT * FROM databases WHERE id = $1', [db.id]);
  if (!fresh) return;
  for (const r of await q("SELECT * FROM db_replicas WHERE database_id = $1 AND status <> 'deleting'", [db.id])) {
    await removeReplicaFiles(ctx, fresh, r);
    await createReplica(ctx, fresh, r);
  }
}

/** Applies allow-list / plan changes to the replicas (pg_hba + reloadable settings). */
export async function syncReplicaConfig(ctx: Ctx, db: Row): Promise<void> {
  if (ctx.driver.name === 'docker') return;
  for (const r of await q("SELECT * FROM db_replicas WHERE database_id = $1 AND status = 'available'", [db.id])) {
    const dir = replicaDir(db.id, r.id);
    if (!existsSync(dir)) continue;
    await writeConfig(await replicaSpec(db, r, r.port));
    await reloadCluster(dir).catch(() => {});
  }
}

/** After an agent / host restart. */
export async function recoverReplicas(ctx: Ctx): Promise<void> {
  if (ctx.driver.name !== 'process') return;
  for (const db of await q("SELECT * FROM databases WHERE node_id = $1 AND status = 'available'", [ctx.nodeId])) await startReplicas(ctx, db);
}

// --- High availability -----------------------------------------------------------------------------

export async function handleDbHaEnable(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db?.high_availability || db.status !== 'available') return;
  let sb = await one("SELECT * FROM db_replicas WHERE database_id = $1 AND role = 'standby'", [db.id]);
  if (sb?.status === 'available') {
    const running = ctx.driver.name === 'docker' || (await isRunning(replicaDir(db.id, sb.id)));
    if (running) return;
  }
  if (!sb) {
    const rid = id('dbr');
    sb = await one("INSERT INTO db_replicas (id, database_id, role, name, slot_name) VALUES ($1,$2,'standby','HA standby',$3) RETURNING *", [rid, db.id, slotName(rid)]);
  }
  dbLog(db, '==> Building the high-availability standby');
  if (await createReplica(ctx, db, sb!)) {
    await rm(path.join(dbRoot(db.id), 'data.failed'), { recursive: true, force: true }).catch(() => {});
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_ha_ready', data: { standbyId: sb!.id } });
  }
}

export async function handleDbHaDisable(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  const sb = await one("SELECT * FROM db_replicas WHERE database_id = $1 AND role = 'standby'", [db.id]);
  if (!sb) return;
  await removeReplicaFiles(ctx, db, sb);
  await q('DELETE FROM db_replicas WHERE id = $1', [sb.id]);
  dbLog(db, '==> High availability disabled; standby removed');
  await changed(db.workspace_id, 'database', db.id);
}

const failingSince = new Map<string, number>();
let haBusy = false;
export const failoverAfterMs = () => Number(process.env.NAV_PG_FAILOVER_SECONDS ?? 30) * 1000;

async function probe(db: Row, port: number): Promise<boolean> {
  const c = await pgConnect(db, port, 'postgres', 3000).catch(() => null);
  if (!c) return false;
  try {
    await c.query({ text: 'SELECT 1', query_timeout: 3000 } as never);
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * Health-checks primaries with high availability every few seconds; after ~30 s without an answer the standby is
 * promoted. Databases with a running job (restart, upgrade, restore, ...) are skipped: they are down on purpose.
 */
export async function monitorHighAvailability(ctx: Ctx): Promise<void> {
  if (haBusy) return;
  haBusy = true;
  try {
    const dbs = await q(
      `SELECT d.* FROM databases d WHERE d.node_id = $1 AND d.status = 'available' AND d.high_availability
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.concurrency_key = 'db:' || d.id AND j.status = 'running')`,
      [ctx.nodeId],
    );
    const ids = new Set(dbs.map((d) => d.id));
    for (const k of failingSince.keys()) if (!ids.has(k)) failingSince.delete(k);
    for (const db of dbs) {
      if (await probe(db, db.port)) {
        if (failingSince.delete(db.id)) dbLog(db, '==> Primary is responding again');
        continue;
      }
      const since = failingSince.get(db.id);
      if (since == null) {
        failingSince.set(db.id, Date.now());
        dbLog(db, `==> Primary is not responding; failing over in ${failoverAfterMs() / 1000}s unless it recovers`, 'warn');
        continue;
      }
      if (Date.now() - since < failoverAfterMs()) continue;
      failingSince.delete(db.id);
      await failover(ctx, db, Math.round((Date.now() - since) / 1000)).catch((err) => dbLog(db, `==> Failover failed: ${err.message}`, 'error'));
    }
  } finally {
    haBusy = false;
  }
}

/** Promotes the standby and makes it the database's primary (same data directory and, when possible, port). */
export async function failover(ctx: Ctx, db: Row, downSeconds: number): Promise<void> {
  const opId = id('dbo');
  await q("INSERT INTO db_operations (id, database_id, kind, status, data) VALUES ($1,$2,'failover','running',$3)", [opId, db.id, { downSeconds }]);
  const sb = await one("SELECT * FROM db_replicas WHERE database_id = $1 AND role = 'standby' AND status = 'available'", [db.id]);
  if (!sb || !(await probe(db, sb.port))) {
    const msg = sb ? 'the standby is not responding either' : 'no standby is available';
    dbLog(db, `==> Cannot fail over: ${msg}`, 'error');
    await opUpdate(opId, 'failed', {}, msg);
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_failover_failed', data: { reason: msg } });
    return;
  }
  dbLog(db, `==> Primary unresponsive for ${downSeconds}s: promoting the standby`, 'warn');
  const started = Date.now();
  const previousPort = db.port;
  let port = db.port;
  if (ctx.driver.name === 'docker') port = await dockerFailover(db, sb);
  else {
    // Fence the old primary so it can never accept writes again.
    const root = dataDir(db.id);
    await stopCluster(root, 'immediate').catch(() => {});
    const pidFile = await readFile(path.join(root, 'postmaster.pid'), 'utf8').catch(() => null);
    if (pidFile && (await isRunning(root))) killTree(Number(pidFile.split(/\r?\n/)[0]), true);
    const c = await pgConnect(db, sb.port, 'postgres');
    try {
      await c.query('SELECT pg_promote(true, 60)');
    } finally {
      await c.end().catch(() => {});
    }
    // Move the promoted cluster into the database's data directory and bring it up on the original port.
    const sbDir = replicaDir(db.id, sb.id);
    await stopCluster(sbDir);
    const failed = path.join(dbRoot(db.id), 'data.failed');
    await rm(failed, { recursive: true, force: true });
    const retryRename = async (a: string, b: string) => {
      for (let i = 0; i < 5; i++) {
        if (await rename(a, b).then(() => true, () => false)) return true;
        await sleep(1000);
      }
      return false;
    };
    const moved = (await retryRename(root, failed)) && (await retryRename(sbDir, root));
    if (!moved) {
      // Keep serving from the standby's directory on its own port; an operator must tidy up.
      await startCluster(await spec(db, sb.port, { dataDir: sbDir }));
      await q('UPDATE databases SET port = $2, updated_at = now() WHERE id = $1', [db.id, sb.port]);
      throw new Error(`promoted standby is serving on port ${sb.port} but its data directory could not be moved into place`);
    }
    try {
      const s = await spec(db, port);
      await writeConfig(s);
      await startCluster(s);
    } catch {
      port = sb.port; // the old port is still held (e.g. by a stuck process): keep the standby's port
      const s = await spec(db, port);
      await writeConfig(s);
      await startCluster(s);
    }
  }
  await q('UPDATE databases SET port = $2, updated_at = now() WHERE id = $1', [db.id, port]);
  await q('DELETE FROM db_replicas WHERE id = $1', [sb.id]);
  const fresh = (await one('SELECT * FROM databases WHERE id = $1', [db.id]))!;
  // Physical slots are not copied to standbys: recreate the remaining replicas' slots on the new primary.
  const replicas = await q("SELECT * FROM db_replicas WHERE database_id = $1 AND status = 'available'", [db.id]);
  const c = await pgConnect(fresh, port, 'postgres').catch(() => null);
  if (c) {
    for (const r of replicas) await c.query('SELECT pg_create_physical_replication_slot($1, true) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1)', [r.slot_name]).catch(() => {});
    await c.end().catch(() => {});
  }
  if (port !== previousPort) await syncReplicaConfig(ctx, fresh);
  if (fresh.pooler_enabled) await startPooler(ctx, fresh, true).catch(() => {});
  const downtime = Math.round((Date.now() - started) / 1000) + downSeconds;
  dbLog(fresh, `==> Failover complete: the standby is now the primary on port ${port}${port !== previousPort ? ` (was ${previousPort}; update external connection strings)` : ''}`, 'warn');
  await opUpdate(opId, 'completed', { previousPort, port, portChanged: port !== previousPort, standbyId: sb.id, downtimeSeconds: downtime });
  await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_failover', data: { standbyId: sb.id, previousPort, port, portChanged: port !== previousPort, downtimeSeconds: downtime } });
  // Restore redundancy with a new standby.
  await enqueue('db_ha_enable', { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
}

// --- Connection pooling (PgBouncer) ----------------------------------------------------------------

const poolers = new Map<string, ChildProcess>();

/** NAV_PGBOUNCER if set, else pgbouncer from PATH; null when not installed. */
export async function pgbouncerBinary(): Promise<string | null> {
  const candidates = [...(process.env.NAV_PGBOUNCER ? [process.env.NAV_PGBOUNCER] : []), isWin ? 'pgbouncer.exe' : 'pgbouncer'];
  for (const bin of candidates) {
    const ok = await execFileP(bin, ['--version'], { timeout: 5000, windowsHide: true }).then(() => true, () => false);
    if (ok) return bin;
  }
  return null;
}

export async function startPooler(ctx: Ctx, db: Row, restart = false): Promise<void> {
  if (restart) await stopPooler(ctx, db);
  else if (poolers.has(db.id)) return;
  const port = db.pooler_port ?? (await freePort());
  const password = decrypt(db.password_enc);
  const poolSize = poolSizeFor(planOf(db).memoryMB);
  if (ctx.driver.name === 'docker') {
    const d = await docker();
    await dockerPullImage(PGBOUNCER_IMAGE, (l) => dbLog(db, l));
    await d.getContainer(`nav-pgb-${db.id}`).remove({ force: true }).catch(() => {});
    const ct = await d.createContainer(dockerPoolerContainer(db as never, { password, port, poolSize }));
    await ct.start();
    await q('UPDATE databases SET pooler_port = $2, pooler_ref = $3 WHERE id = $1', [db.id, port, ct.id]);
    return;
  }
  const bin = await pgbouncerBinary();
  if (!bin) throw new Error(PGBOUNCER_MISSING);
  const dir = poolerDir(db.id);
  await mkdir(dir, { recursive: true });
  const cfg = pgbouncerConfig({
    dbName: db.db_name, user: db.db_user, password, serverHost: '127.0.0.1', serverPort: db.port, listenAddr: '*', listenPort: port, poolSize, dir,
    allowList: (db.ip_allow_list ?? []).map((e: { cidr: string }) => e.cidr), isWindows: isWin,
  });
  await writeFile(path.join(dir, 'pgbouncer.ini'), cfg.ini, { mode: 0o600 });
  await writeFile(path.join(dir, 'userlist.txt'), cfg.userlist, { mode: 0o600 });
  await writeFile(path.join(dir, 'pgbouncer_hba.conf'), cfg.hba, { mode: 0o600 });
  const child = spawn(bin, [path.join(dir, 'pgbouncer.ini')], { cwd: dir, windowsHide: true, detached: !isWin });
  pipeLines(child.stdout!, (l) => dbLog(db, `[pgbouncer] ${l}`));
  pipeLines(child.stderr!, (l) => dbLog(db, `[pgbouncer] ${l}`, /ERROR|FATAL/.test(l) ? 'error' : 'info'));
  poolers.set(db.id, child);
  child.on('exit', (code) => {
    if (poolers.get(db.id) === child) poolers.delete(db.id);
    dbLog(db, `==> PgBouncer exited with code ${code}`, code ? 'error' : 'info');
  });
  await q('UPDATE databases SET pooler_port = $2, pooler_ref = $3 WHERE id = $1', [db.id, port, String(child.pid)]);
}

export async function stopPooler(ctx: Ctx, db: Row): Promise<void> {
  if (ctx.driver.name === 'docker') {
    await (await docker()).getContainer(`nav-pgb-${db.id}`).remove({ force: true }).catch(() => {});
    return;
  }
  const child = poolers.get(db.id);
  poolers.delete(db.id);
  if (child) killTree(child.pid, false);
  else if (db.pooler_ref) killTree(Number(db.pooler_ref), true);
}

export async function handleDbPoolerStart(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db?.pooler_enabled || db.status !== 'available') return;
  try {
    await startPooler(ctx, db, true);
    const fresh = await one('SELECT pooler_port FROM databases WHERE id = $1', [db.id]);
    dbLog(db, `==> PgBouncer (transaction pooling) is listening on port ${fresh?.pooler_port}`);
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_pooler_enabled', data: { port: fresh?.pooler_port } });
  } catch (err) {
    dbLog(db, `==> Connection pooling failed: ${(err as Error).message}`, 'error');
    await q('UPDATE databases SET pooler_enabled = false WHERE id = $1', [db.id]);
  }
  await changed(db.workspace_id, 'database', db.id);
}

export async function handleDbPoolerStop(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  await stopPooler(ctx, db);
  await q('UPDATE databases SET pooler_port = NULL, pooler_ref = NULL WHERE id = $1', [db.id]);
  dbLog(db, '==> Connection pooling disabled');
  await changed(db.workspace_id, 'database', db.id);
}

export async function recoverPoolers(ctx: Ctx): Promise<void> {
  if (ctx.driver.name !== 'process') return;
  for (const db of await q("SELECT * FROM databases WHERE node_id = $1 AND status = 'available' AND pooler_enabled", [ctx.nodeId])) {
    if (db.pooler_ref) killTree(Number(db.pooler_ref), true);
    await startPooler(ctx, db, true).catch((err) => dbLog(db, `==> PgBouncer failed to start: ${err.message}`, 'error'));
  }
}

// --- Major version upgrades ------------------------------------------------------------------------

/** pg_dump | pg_restore (or any two tools) connected by a pipe. */
function pipeTools(a: { bin: string; args: string[] }, b: { bin: string; args: string[] }, env: Record<string, string>): Promise<{ codeA: number; codeB: number; err: string }> {
  return new Promise((resolve, reject) => {
    const opts = { env: { ...process.env, ...env }, windowsHide: true };
    const pa = spawn(a.bin, a.args, opts);
    const pb = spawn(b.bin, b.args, opts);
    let err = '';
    const keep = (d: Buffer) => { err = (err + d.toString()).slice(-4000); };
    pa.stderr.on('data', keep);
    pb.stderr.on('data', keep);
    pb.stdout.on('data', keep);
    pa.stdout.pipe(pb.stdin);
    pb.stdin.on('error', () => {});
    let codeA: number | null = null;
    let codeB: number | null = null;
    const done = () => { if (codeA !== null && codeB !== null) resolve({ codeA, codeB, err }); };
    pa.on('error', reject);
    pb.on('error', reject);
    pa.on('close', (c) => { codeA = c ?? 1; done(); });
    pb.on('close', (c) => { codeB = c ?? 1; done(); });
  });
}

export interface UpgradeTools { method: 'pg_upgrade' | 'dump_restore'; pgUpgrade?: string; oldBin?: string; newBin: string; pgDump?: string; pgDumpAll?: string; pgRestore?: string }

/** Which way a process-driver cluster can be upgraded from `from` to `to` on this node (null: not possible). */
export async function upgradeTools(from: number, to: number, prefer?: 'pg_upgrade' | 'dump_restore'): Promise<UpgradeTools | null> {
  const target = await pgServerInstall(to).catch(() => null);
  if (!target) return null;
  // pg_upgrade needs complete installations of both versions (it runs pg_controldata, pg_resetwal, psql, ...).
  const all = await pgInstalls();
  const oldFull = all.find((i) => i.version === from && isFullInstall(i));
  const newFull = all.find((i) => i.version === to && isFullInstall(i) && hasTool(i, 'pg_upgrade'));
  const pgDump = await pgTool('pg_dump', Math.max(from, to));
  const pgDumpAll = await pgTool('pg_dumpall', Math.max(from, to));
  const pgRestore = await pgTool('pg_restore', Math.max(from, to));
  const canDump = Boolean(pgDump && pgDumpAll && pgRestore);
  if (oldFull && newFull && prefer !== 'dump_restore') return { method: 'pg_upgrade', pgUpgrade: toolPath(newFull, 'pg_upgrade'), oldBin: oldFull.binDir, newBin: newFull.binDir };
  if (canDump && prefer !== 'pg_upgrade') return { method: 'dump_restore', newBin: target.binDir, pgDump: pgDump!, pgDumpAll: pgDumpAll!, pgRestore: pgRestore! };
  return null;
}

/** Copies roles and every database from a running cluster into another (writes are frozen first). */
async function dumpRestore(db: Row, oldPort: number, newPort: number, t: UpgradeTools, log: (m: string) => void): Promise<void> {
  const env = { PGPASSWORD: decrypt(db.password_enc) };
  const conn = (port: number) => ['-h', '127.0.0.1', '-p', String(port), '-U', db.db_user, '-w'];
  const c = await pgConnect(db, oldPort, 'postgres');
  let names: string[];
  try {
    await c.query('ALTER SYSTEM SET default_transaction_read_only = on');
    await c.query('SELECT pg_reload_conf()');
    await sleep(500);
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'");
    names = (await c.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1")).rows.map((r) => r.datname);
  } finally {
    await c.end().catch(() => {});
  }
  log('==> Writes are paused; copying roles');
  const globalsFile = path.join(dbRoot(db.id), 'upgrade-globals.sql');
  const g = await runPg(t.pgDumpAll!, [...conn(oldPort), '--globals-only', '-f', globalsFile], { env });
  if (g.code !== 0) throw new Error(`pg_dumpall failed: ${g.out.slice(-600)}`);
  const nc = await pgConnect(db, newPort, 'postgres');
  try {
    for (const st of globalsStatements(await readFile(globalsFile, 'utf8'))) {
      await nc.query(st).catch((err) => { if (!/already exists/.test(err.message)) log(`    (skipped) ${err.message}`); });
    }
  } finally {
    await nc.end().catch(() => {});
    await rm(globalsFile, { force: true });
  }
  for (const name of names) {
    log(`==> Copying database ${name}`);
    const r = await pipeTools(
      { bin: t.pgDump!, args: [...conn(oldPort), '-Fc', '-d', name] },
      { bin: t.pgRestore!, args: [...conn(newPort), '-C', '-d', 'postgres'] },
      env,
    );
    if (r.codeA !== 0 || r.codeB !== 0) throw new Error(`copying ${name} failed: ${r.err.slice(-800)}`);
  }
}

async function unfreeze(db: Row): Promise<void> {
  const c = await pgConnect(db, db.port, 'postgres').catch(() => null);
  if (!c) return;
  await c.query('ALTER SYSTEM RESET default_transaction_read_only').catch(() => {});
  await c.query('SELECT pg_reload_conf()').catch(() => {});
  await c.end().catch(() => {});
}

export async function handleDbUpgrade(ctx: Ctx, payload: { databaseId: string; version: number; operationId?: string; method?: 'pg_upgrade' | 'dump_restore' }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  const log = (m: string, level = 'info') => dbLog(db, m, level);
  const to = payload.version;
  await opUpdate(payload.operationId, 'running');
  if (ctx.driver.name === 'docker') return dockerUpgrade(ctx, db, to, payload.operationId);
  const root = dataDir(db.id);
  const next = path.join(dbRoot(db.id), `data-${to}`);
  const aside = path.join(dbRoot(db.id), 'data.pre-upgrade');
  const archive = archiveDir(db.id);
  const archiveAside = `${archive}.pre-upgrade`;
  const from = (await clusterVersion(root)) ?? db.pg_version;
  let switched = false;
  try {
    const t = await upgradeTools(from, to, payload.method);
    if (!t) throw new Error(`PostgreSQL ${to} binaries (and pg_upgrade or pg_dump/pg_restore) are not installed on this node`);
    log(`==> Upgrading PostgreSQL ${from} → ${to} using ${t.method === 'pg_upgrade' ? 'pg_upgrade' : 'dump and restore'}`);
    await stopReplicas(ctx, db);
    await stopPooler(ctx, db).catch(() => {});
    await stopCluster(next, 'immediate').catch(() => {});
    await rm(next, { recursive: true, force: true });
    const tmpPort = await freePort();
    const s = await spec(db, tmpPort, { dataDir: next, version: to, binDir: t.newBin, archiveDir: undefined });
    await initCluster(s, (l) => log(l), to >= 18 && from < 18 ? ['--no-data-checksums'] : []);
    await writeConfig(s);
    if (t.method === 'pg_upgrade') {
      await stopCluster(root);
      const work = path.join(dbRoot(db.id), 'upgrade-work');
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      const oldPort = await freePort();
      const res = await runPg(t.pgUpgrade!, ['-b', t.oldBin!, '-B', t.newBin, '-d', root, '-D', next, '-U', db.db_user, '-p', String(oldPort), '-P', String(tmpPort)], {
        cwd: work, env: { PGPASSWORD: decrypt(db.password_enc) }, onLine: (l) => log(l),
      });
      await rm(work, { recursive: true, force: true }).catch(() => {});
      if (res.code !== 0) throw new Error(`pg_upgrade failed: ${res.out.slice(-1200)}`);
    } else {
      await startCluster(s, (l) => log(l));
      await dumpRestore(db, db.port, tmpPort, t, log);
      await stopCluster(next);
      await stopCluster(root);
    }
    // Switch: the new cluster takes the data directory and port; the old one is kept until it is up.
    await rm(aside, { recursive: true, force: true });
    await rename(root, aside);
    await rename(next, root);
    switched = true;
    await rm(archiveAside, { recursive: true, force: true });
    if (existsSync(archive)) await rename(archive, archiveAside);
    const live = await spec(db, db.port);
    await writeConfig(live);
    await startCluster(live, (l) => log(l));
    const c = await pgConnect(db);
    await c.query('ANALYZE').catch(() => {});
    await c.end().catch(() => {});
    await q('UPDATE databases SET pg_version = $2, pitr_enabled_at = $3 WHERE id = $1', [db.id, to, live.archiveDir ? new Date().toISOString() : null]);
    await rm(aside, { recursive: true, force: true }).catch(() => {});
    await rm(archiveAside, { recursive: true, force: true }).catch(() => {});
    await setStatus(db, 'available');
    log(`==> Upgrade complete: PostgreSQL ${to}`);
    await opUpdate(payload.operationId, 'completed', { from, to, method: t.method });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_upgraded', data: { from, to, method: t.method } });
    if (live.archiveDir) await queueBaseBackup(db);
    const fresh = (await one('SELECT * FROM databases WHERE id = $1', [db.id]))!;
    await rebuildReplicas(ctx, fresh).catch((err) => log(`==> Replica rebuild failed: ${err.message}`, 'error'));
    if (fresh.pooler_enabled) await startPooler(ctx, fresh, true).catch(() => {});
  } catch (err) {
    log(`==> Upgrade failed, keeping PostgreSQL ${from}: ${(err as Error).message}`, 'error');
    await stopCluster(root, 'immediate').catch(() => {});
    if (switched) {
      await rm(next, { recursive: true, force: true }).catch(() => {});
      await rename(root, next).catch(() => {});
      await rename(aside, root).catch(() => {});
      if (existsSync(archiveAside)) {
        await rm(archive, { recursive: true, force: true }).catch(() => {});
        await rename(archiveAside, archive).catch(() => {});
      }
    }
    await stopCluster(next, 'immediate').catch(() => {});
    await rm(next, { recursive: true, force: true }).catch(() => {});
    await startCluster(await spec(db, db.port), (l) => log(l)).catch((e) => log(`==> Could not restart the old cluster: ${e.message}`, 'error'));
    await unfreeze(db);
    await startReplicas(ctx, db).catch(() => {});
    if (db.pooler_enabled) await startPooler(ctx, db, true).catch(() => {});
    await setStatus(db, 'available');
    await opUpdate(payload.operationId, 'failed', { from, to }, (err as Error).message.slice(0, 2000));
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_upgrade_failed', data: { from, to, error: (err as Error).message.slice(0, 300) } });
  }
}

// --- Repack ----------------------------------------------------------------------------------------

export async function handleDbRepack(ctx: Ctx, payload: { databaseId: string; operationId: string; schema: string; table: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  const rel = `${ident(payload.schema)}.${ident(payload.table)}`;
  await opUpdate(payload.operationId, 'running');
  const c = await pgConnect(db).catch(async (err) => {
    await opUpdate(payload.operationId, 'failed', {}, err.message);
    return null;
  });
  if (!c) return;
  try {
    const size = async () => Number((await c.query('SELECT pg_total_relation_size($1::regclass) AS s', [rel])).rows[0].s);
    const before = await size();
    let method = 'vacuum_full';
    const version = ctx.driver.name === 'docker' ? null : ((await clusterVersion(dataDir(db.id))) ?? db.pg_version);
    const repack = version ? await pgTool('pg_repack', version, true) : null;
    if (repack) {
      const ext = await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'pg_repack'");
      if (ext.rowCount) {
        await c.query('CREATE EXTENSION IF NOT EXISTS pg_repack');
        dbLog(db, `==> pg_repack ${rel} (online, brief locks only at the start and end)`);
        const r = await runPg(repack, ['-h', '127.0.0.1', '-p', String(db.port), '-U', db.db_user, '-d', db.db_name, '-t', rel, '--no-superuser-check'], { env: { PGPASSWORD: decrypt(db.password_enc) } });
        if (r.code === 0) method = 'pg_repack';
        else dbLog(db, `==> pg_repack failed (${r.out.slice(-300)}); falling back to VACUUM FULL`, 'warn');
      }
    }
    if (method === 'vacuum_full') {
      dbLog(db, `==> VACUUM (FULL, ANALYZE) ${rel}: the table is locked until it finishes`);
      await c.query(`VACUUM (FULL, ANALYZE) ${rel}`);
    }
    const after = await size();
    dbLog(db, `==> Repacked ${rel}: ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`);
    await opUpdate(payload.operationId, 'completed', { method, beforeBytes: before, afterBytes: after });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_repacked', data: { table: `${payload.schema}.${payload.table}`, method, beforeBytes: before, afterBytes: after } });
  } catch (err) {
    dbLog(db, `==> Repack of ${rel} failed: ${(err as Error).message}`, 'error');
    await opUpdate(payload.operationId, 'failed', {}, (err as Error).message.slice(0, 2000));
  } finally {
    await c.end().catch(() => {});
    await changed(db.workspace_id, 'database', db.id);
  }
}

// --- Node capabilities -----------------------------------------------------------------------------

export interface PgCapability { version: number; server: boolean; full: boolean; pgUpgrade: boolean; pgDump: boolean; pgBasebackup: boolean; pgRepack: boolean; postgis: boolean }
export interface NodeCapabilities { driver: string; pgbouncer: boolean; postgres: PgCapability[] }

/** What this node can run, stored on its nodes row so the API can answer 409s and list upgrade targets. */
export async function detectCapabilities(driver: string): Promise<NodeCapabilities> {
  if (driver === 'docker') {
    return { driver, pgbouncer: true, postgres: [14, 15, 16, 17, 18].map((version) => ({ version, server: true, full: false, pgUpgrade: false, pgDump: true, pgBasebackup: true, pgRepack: false, postgis: false })) };
  }
  const installs = await pgInstalls(true);
  const versions = [...new Set(installs.map((i) => i.version))].sort((a, b) => a - b);
  const postgres = versions.map((version) => {
    const at = installs.filter((i) => i.version === version);
    return {
      version,
      server: at.some((i) => hasTool(i, 'initdb') && hasTool(i, 'pg_ctl') && hasTool(i, 'postgres')),
      full: at.some(isFullInstall),
      pgUpgrade: at.some((i) => hasTool(i, 'pg_upgrade') && isFullInstall(i)),
      pgDump: at.some((i) => hasTool(i, 'pg_dump') && hasTool(i, 'pg_dumpall') && hasTool(i, 'pg_restore')),
      pgBasebackup: at.some((i) => hasTool(i, 'pg_basebackup')),
      pgRepack: at.some((i) => hasTool(i, 'pg_repack')),
      postgis: at.some((i) => hasExtension(i, 'postgis')),
    };
  });
  return { driver, pgbouncer: Boolean(await pgbouncerBinary()), postgres };
}

// --- Docker driver ---------------------------------------------------------------------------------

/** Runs a command in a container and returns its exit code. */
async function dockerExec(container: import('dockerode').Container, cmd: string[], user = 'postgres'): Promise<number> {
  const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, User: user });
  const stream = await ex.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve) => { stream.on('end', resolve); stream.on('close', resolve); stream.resume(); });
  return (await ex.inspect()).ExitCode ?? 1;
}

async function dockerCreateReplica(db: Row, r: Row, log: (m: string) => void): Promise<void> {
  const d = await docker();
  const password = decrypt(db.password_enc);
  // The primary must accept replication connections from the workspace network and hold a slot for the replica.
  if ((await dockerExec(d.getContainer(`nav-db-${db.id}`), dockerEnableReplicationCmd())) !== 0) throw new Error('could not enable replication on the primary');
  const c = await pgConnect(db, db.port, 'postgres');
  try {
    await c.query('SELECT pg_reload_conf()');
    await c.query('SELECT pg_create_physical_replication_slot($1, true) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1)', [r.slot_name]);
  } finally {
    await c.end().catch(() => {});
  }
  await dockerPullImage(`postgres:${db.pg_version}`, log);
  await dockerEnsureNetwork(db.workspace_id);
  const port = r.port ?? (await freePort());
  await d.getContainer(`nav-dbr-${r.id}`).remove({ force: true }).catch(() => {});
  await d.createVolume({ Name: `nav-dbr-${r.id}`, Labels: { 'nav.database': db.id } });
  const plan = planOf(db);
  const ct = await d.createContainer(dockerReplicaContainer(db as never, r as never, { password, port, memoryMB: plan.memoryMB, cpu: plan.cpu }));
  await ct.start();
  if (!(await waitForPostgres(db, port, 180))) throw new Error('the replica container did not become ready');
  await replicaStatus(r, 'available', { node_id: db.node_id, host: '127.0.0.1', port, ref: ct.id });
}

/** Docker failover: promote, retire the old primary container and give the standby its name and network alias. */
async function dockerFailover(db: Row, sb: Row): Promise<number> {
  const d = await docker();
  const old = d.getContainer(`nav-db-${db.id}`);
  await old.stop({ t: 0 }).catch(() => {});
  const c = await pgConnect(db, sb.port, 'postgres');
  try {
    await c.query('SELECT pg_promote(true, 60)');
  } finally {
    await c.end().catch(() => {});
  }
  await old.remove({ force: true }).catch(() => {});
  const ct = d.getContainer(`nav-dbr-${sb.id}`);
  await ct.rename({ name: `nav-db-${db.id}` });
  const network = d.getNetwork(`nav-${db.workspace_id}`);
  await network.disconnect({ Container: ct.id }).catch(() => {});
  await network.connect({ Container: ct.id, EndpointConfig: { Aliases: [db.slug] } });
  await q('UPDATE databases SET ref = $2 WHERE id = $1', [db.id, sb.ref]);
  return sb.port; // host port bindings are fixed per container: the external port changes
}

/** Pipes a command's stdout in one container into another command's stdin in a second container. */
async function dockerPipe(from: import('dockerode').Container, fromCmd: string[], to: import('dockerode').Container, toCmd: string[]): Promise<{ from: number; to: number }> {
  const d = await docker();
  const src = await from.exec({ Cmd: fromCmd, AttachStdout: true, AttachStderr: true, User: 'postgres' });
  const dst = await to.exec({ Cmd: toCmd, AttachStdin: true, AttachStdout: true, AttachStderr: true, User: 'postgres' });
  const dstStream = await dst.start({ hijack: true, stdin: true });
  const srcStream = await src.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  err.resume();
  d.modem.demuxStream(srcStream, out, err);
  dstStream.resume();
  out.pipe(dstStream as unknown as NodeJS.WritableStream, { end: false });
  await new Promise<void>((resolve) => srcStream.on('end', resolve));
  (dstStream as unknown as { end: () => void }).end();
  for (let i = 0; i < 3600; i++) {
    if (!(await dst.inspect()).Running) break;
    await sleep(1000);
  }
  return { from: (await src.inspect()).ExitCode ?? 1, to: (await dst.inspect()).ExitCode ?? 1 };
}

async function dockerUpgrade(ctx: Ctx, db: Row, to: number, opId?: string): Promise<void> {
  const d = await docker();
  const plan = planOf(db);
  const password = decrypt(db.password_enc);
  const from = db.pg_version;
  const newVolume = `nav-db-${db.id}-v${to}`;
  const tmpName = `nav-dbu-${db.id}`;
  let oldRemoved = false;
  try {
    await dockerPullImage(`postgres:${to}`, (l) => dbLog(db, l));
    await stopReplicas(ctx, db);
    await stopPooler(ctx, db).catch(() => {});
    await d.getContainer(tmpName).remove({ force: true }).catch(() => {});
    await d.getVolume(newVolume).remove().catch(() => {});
    await d.createVolume({ Name: newVolume, Labels: { 'nav.database': db.id } });
    const tmpPort = await freePort();
    const tmp = await d.createContainer(dockerPostgresContainer(db as never, { password, port: tmpPort, volume: newVolume, version: to, memoryMB: plan.memoryMB, cpu: plan.cpu, name: tmpName, bindIp: '127.0.0.1' }));
    await tmp.start();
    if (!(await waitForPostgres(db, tmpPort, 120))) throw new Error(`PostgreSQL ${to} container did not start`);
    const c = await pgConnect(db, db.port, 'postgres');
    await c.query('ALTER SYSTEM SET default_transaction_read_only = on');
    await c.query('SELECT pg_reload_conf()');
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'");
    await c.end().catch(() => {});
    const cmds = dockerUpgradeCommands(db.db_user);
    dbLog(db, `==> Copying data into PostgreSQL ${to} (pg_dumpall | psql)`);
    const r = await dockerPipe(d.getContainer(`nav-db-${db.id}`), cmds.dump, tmp, cmds.restore);
    if (r.from !== 0) throw new Error(`pg_dumpall exited with ${r.from}`);
    await tmp.remove({ force: true });
    // Recreate the primary container on the new volume with the original name, port and alias.
    const old = d.getContainer(`nav-db-${db.id}`);
    await old.stop().catch(() => {});
    await old.rename({ name: `nav-db-${db.id}-v${from}-old` });
    oldRemoved = true;
    const ct = await d.createContainer(dockerPostgresContainer(db as never, { password, port: db.port, volume: newVolume, version: to, memoryMB: plan.memoryMB, cpu: plan.cpu }));
    await ct.start();
    if (!(await waitForPostgres(db, db.port, 120))) throw new Error(`PostgreSQL ${to} did not start on port ${db.port}`);
    await d.getContainer(`nav-db-${db.id}-v${from}-old`).remove({ force: true }).catch(() => {});
    await q('UPDATE databases SET pg_version = $2, ref = $3 WHERE id = $1', [db.id, to, ct.id]);
    await setStatus(db, 'available');
    await opUpdate(opId, 'completed', { from, to, method: 'dump_restore' });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_upgraded', data: { from, to, method: 'dump_restore' } });
    const fresh = (await one('SELECT * FROM databases WHERE id = $1', [db.id]))!;
    await rebuildReplicas(ctx, fresh).catch(() => {});
    if (fresh.pooler_enabled) await startPooler(ctx, fresh, true).catch(() => {});
  } catch (err) {
    dbLog(db, `==> Upgrade failed, keeping PostgreSQL ${from}: ${(err as Error).message}`, 'error');
    await d.getContainer(tmpName).remove({ force: true }).catch(() => {});
    if (oldRemoved) {
      await d.getContainer(`nav-db-${db.id}`).remove({ force: true }).catch(() => {});
      await d.getContainer(`nav-db-${db.id}-v${from}-old`).rename({ name: `nav-db-${db.id}` }).catch(() => {});
    }
    await d.getContainer(`nav-db-${db.id}`).start().catch(() => {});
    await d.getVolume(newVolume).remove().catch(() => {});
    if (await waitForPostgres(db, db.port, 30)) await unfreeze(db);
    await startReplicas(ctx, db).catch(() => {});
    if (db.pooler_enabled) await startPooler(ctx, db, true).catch(() => {});
    await setStatus(db, 'available');
    await opUpdate(opId, 'failed', { from, to }, (err as Error).message.slice(0, 2000));
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_upgrade_failed', data: { from, to, error: (err as Error).message.slice(0, 300) } });
  }
}
