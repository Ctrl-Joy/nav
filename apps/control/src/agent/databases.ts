// Managed PostgreSQL on this node. Process driver: real clusters via initdb/pg_ctl. Docker driver: postgres images.
// Replicas, high availability, pooling, upgrades and repack live in ./pgfeatures.ts.
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import tar from 'tar-stream';
import { config } from '@nav/shared/config';
import { decrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { DATABASE_PLANS, pitrRetentionDays } from '@nav/shared';
import { one, q, type Row } from '../db/pool.ts';
import { changed, enqueue, recordEvent } from '../lib/core.ts';
import {
  clusterVersion, hasExtension, initCluster, isRunning, pgServerInstall, reloadCluster, startCluster, stopCluster, writeConfig, type ClusterSpec,
} from '../lib/pgcluster.ts';
import { dockerPostgresContainer } from '../lib/pgcommands.ts';
import type { Ctx } from './handlers.ts';
import { rebuildReplicas, startPooler, stopPooler, startReplicas, stopReplicas, syncReplicaConfig } from './pgfeatures.ts';
import { freePort, shipLog, sleep } from './util.ts';

export const dbRoot = (id: string) => path.join(config.dataDir, 'databases', id);
export const dataDir = (id: string) => path.join(dbRoot(id), 'data');
export const backupDir = (id: string) => path.join(config.dataDir, 'backups', id);
/** Continuous WAL archive for point-in-time recovery (process driver). */
export const archiveDir = (id: string) => path.join(config.dataDir, 'wal-archive', id);

/** Cluster settings for a database. Binaries follow the data directory's PG_VERSION (see pgcluster.startCluster). */
export async function spec(db: Row, port: number, over: Partial<ClusterSpec> = {}): Promise<ClusterSpec> {
  const plan = DATABASE_PLANS.find((p) => p.id === db.plan);
  const version = (await clusterVersion(over.dataDir ?? dataDir(db.id))) ?? db.pg_version;
  const inst = await pgServerInstall(version).catch(() => null);
  return {
    dataDir: dataDir(db.id),
    port,
    superuser: db.db_user,
    password: decrypt(db.password_enc),
    listen: '*',
    allowList: (db.ip_allow_list ?? []).map((e: { cidr: string }) => e.cidr),
    memoryMB: plan?.memoryMB ?? 256,
    archiveDir: pitrRetentionDays(db.plan) > 0 ? archiveDir(db.id) : undefined,
    preload: inst && hasExtension(inst, 'pg_stat_statements') ? ['pg_stat_statements'] : undefined,
    maxSlotWalKeepMB: Math.max(1024, (db.disk_gb ?? 1) * 256),
    ...over,
  };
}

export const dbLog = (db: Row, message: string, level = 'info') => shipLog({ databaseId: db.id, stream: 'system' }, message, level);

export async function setStatus(db: Row, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const keys = Object.keys(extra);
  await q(`UPDATE databases SET status = $2${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')}, updated_at = now() WHERE id = $1`, [db.id, status, ...keys.map((k) => extra[k])]);
  await changed(db.workspace_id, 'database', db.id);
}

/** A connected client to a database's cluster on this node. */
export async function pgConnect(db: Row, port: number = db.port, database: string = db.db_name, timeoutMs = 5000): Promise<pg.Client> {
  const c = new pg.Client({ host: '127.0.0.1', port, user: db.db_user, password: decrypt(db.password_enc), database, connectionTimeoutMillis: timeoutMs });
  c.on('error', () => {});
  try {
    await c.connect();
  } catch (err) {
    await c.end().catch(() => {});
    throw err;
  }
  return c;
}

/** Queues a base backup (PITR needs one before its window opens). */
export async function queueBaseBackup(db: Row): Promise<void> {
  const bid = id('bkp');
  await q("INSERT INTO db_backups (id, database_id, kind) VALUES ($1,$2,'automatic')", [bid, db.id]);
  await enqueue('db_backup', { databaseId: db.id, backupId: bid }, { concurrencyKey: `db:${db.id}` });
}

/** Starts a fresh PITR history (after anything that rewrites the cluster's WAL: in-place restore, upgrade). */
async function resetPitr(db: Row): Promise<void> {
  await rm(archiveDir(db.id), { recursive: true, force: true }).catch(() => {});
  const on = pitrRetentionDays(db.plan) > 0 && db.driver !== 'docker';
  await q('UPDATE databases SET pitr_enabled_at = $2 WHERE id = $1', [db.id, on ? new Date().toISOString() : null]);
}

export async function handleDbProvision(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db || db.status === 'deleting') return;
  if (ctx.driver.name === 'docker') return dockerProvision(ctx, db);
  try {
    // The requested major version when it is installed here, else the node's default (embedded) version.
    const inst = (await pgServerInstall(db.pg_version).catch(() => null)) ?? (await pgServerInstall());
    if (inst.version !== db.pg_version) {
      dbLog(db, `==> PostgreSQL ${db.pg_version} is not installed on this node; using PostgreSQL ${inst.version}`, 'warn');
      await q('UPDATE databases SET pg_version = $2 WHERE id = $1', [db.id, inst.version]);
      db.pg_version = inst.version;
    }
    const port = db.port ?? (await freePort());
    const s = await spec(db, port, { version: inst.version });
    dbLog(db, `==> Creating PostgreSQL ${db.pg_version} cluster`);
    await mkdir(dbRoot(db.id), { recursive: true });
    await initCluster(s, (l) => dbLog(db, l));
    await writeConfig(s);
    await startCluster(s, (l) => dbLog(db, l));
    const c = new pg.Client({ host: '127.0.0.1', port, user: db.db_user, password: s.password, database: 'postgres' });
    await c.connect();
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.db_name]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE "${db.db_name.replace(/"/g, '')}" OWNER "${db.db_user.replace(/"/g, '')}"`);
    await c.end();
    await setStatus(db, 'available', { driver: 'process', node_id: ctx.nodeId, host: '127.0.0.1', port, pitr_enabled_at: s.archiveDir ? new Date().toISOString() : null });
    dbLog(db, `==> Database is available on port ${port}`);
    if (s.archiveDir) {
      dbLog(db, `==> Continuous WAL archiving is on (point-in-time recovery, ${pitrRetentionDays(db.plan)} days); taking the first base backup`);
      await queueBaseBackup(db);
    }
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_available' });
  } catch (err) {
    dbLog(db, `==> Provisioning failed: ${(err as Error).message}`, 'error');
    await setStatus(db, 'failed');
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_failed', data: { error: (err as Error).message.slice(0, 300) } });
  }
}

/** Re-applies config (IP allow list, memory, WAL archiving) and reloads; restarts when a setting needs it. */
export async function handleDbReconfigure(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db?.port || db.status !== 'available') return;
  if (ctx.driver.name === 'docker') return;
  const s = await spec(db, db.port);
  await writeConfig(s);
  await reloadCluster(dataDir(db.id));
  dbLog(db, '==> Configuration reloaded (access control updated)');
  await sleep(1000);
  const c = await pgConnect(db).catch(() => null);
  const pending = c ? (await c.query('SELECT name FROM pg_settings WHERE pending_restart').catch(() => ({ rows: [] }))).rows.map((r) => r.name) : [];
  await c?.end().catch(() => {});
  if (pending.length) {
    dbLog(db, `==> Restarting to apply ${pending.join(', ')}`);
    await stopCluster(dataDir(db.id));
    await startCluster(s, (l) => dbLog(db, l));
  }
  if (s.archiveDir && !db.pitr_enabled_at) {
    await q('UPDATE databases SET pitr_enabled_at = now() WHERE id = $1', [db.id]);
    dbLog(db, '==> Point-in-time recovery enabled; taking a base backup');
    await queueBaseBackup(db);
  } else if (!s.archiveDir && db.pitr_enabled_at) {
    await q('UPDATE databases SET pitr_enabled_at = NULL WHERE id = $1', [db.id]);
  }
  await syncReplicaConfig(ctx, db);
  if (db.pooler_enabled) await startPooler(ctx, db, true).catch((err) => dbLog(db, `==> Pooler restart failed: ${err.message}`, 'error'));
}

export async function handleDbSuspend(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  await stopPooler(ctx, db).catch(() => {});
  await stopReplicas(ctx, db).catch(() => {});
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'stop');
  else await stopCluster(dataDir(db.id));
  dbLog(db, '==> Database suspended');
  await setStatus(db, 'suspended');
}

export async function handleDbResume(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'start');
  else await startCluster(await spec(db, db.port));
  await startReplicas(ctx, db).catch((err) => dbLog(db, `==> Replica start failed: ${err.message}`, 'error'));
  if (db.pooler_enabled) await startPooler(ctx, db).catch((err) => dbLog(db, `==> Pooler start failed: ${err.message}`, 'error'));
  dbLog(db, '==> Database resumed');
  await setStatus(db, 'available');
}

export async function handleDbRestart(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'restart');
  else {
    // A restart also applies settings that only take effect at server start (e.g. preloading pg_stat_statements).
    const s = await spec(db, db.port);
    await stopCluster(dataDir(db.id));
    await writeConfig(s);
    await startCluster(s);
  }
  dbLog(db, '==> Database restarted');
  await setStatus(db, 'available');
}

export async function handleDbDelete(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  await stopPooler(ctx, db).catch(() => {});
  await stopReplicas(ctx, db, true).catch(() => {});
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'remove');
  else await stopCluster(dataDir(db.id), 'immediate').catch(() => {});
  await rm(dbRoot(db.id), { recursive: true, force: true }).catch(() => {});
  await rm(backupDir(db.id), { recursive: true, force: true }).catch(() => {});
  await rm(archiveDir(db.id), { recursive: true, force: true }).catch(() => {});
  await q('DELETE FROM logs WHERE database_id = $1', [db.id]);
  await q('DELETE FROM metrics WHERE service_id = $1', [db.id]);
  await q('DELETE FROM blueprint_resources WHERE resource_id = $1', [db.id]);
  await q('DELETE FROM databases WHERE id = $1', [db.id]);
  await changed(db.workspace_id, 'database', db.id);
}

// --- Backups ---------------------------------------------------------------------------------------
// Process driver: online physical backup using the non-exclusive backup API (pg_backup_start/stop) — a
// consistent base backup including the WAL needed to recover it, packed as tar.gz. With WAL archiving on, the
// same backups are the base backups of point-in-time recovery.

/** Files that must not be copied from a live data directory. */
export const skipLive = (r: string) => /^(pg_wal\/|postmaster\.(pid|opts)$|server\.log$|pg_replslot\/|pg_stat_tmp\/|pg_dynshmem\/|pg_notify\/|pg_serial\/|pg_snapshots\/|pg_subtrans\/|standby\.signal$|recovery\.signal$)/.test(r) || r === 'pg_wal';
export const EMPTY_DIRS = ['pg_wal', 'pg_wal/archive_status', 'pg_replslot', 'pg_stat_tmp', 'pg_dynshmem', 'pg_notify', 'pg_serial', 'pg_snapshots', 'pg_subtrans'];

/** Walks a live data directory (files may vanish during the walk; the backup protocol allows it). */
export async function walkDir(root: string, rel: string, skip: (rel: string) => boolean, onDir: (rel: string) => Promise<void>, onFile: (rel: string, data: Buffer) => Promise<void>): Promise<void> {
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    const full = path.join(root, r);
    if (e.isDirectory()) {
      await onDir(r);
      await walkDir(root, r, skip, onDir, onFile);
    } else if (e.isFile()) {
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      const fh = await open(full, 'r').catch(() => null);
      if (!fh) continue;
      try {
        const buf = Buffer.alloc(st.size);
        const { bytesRead } = await fh.read(buf, 0, st.size, 0);
        await onFile(r, buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    }
  }
}

export async function handleDbBackup(ctx: Ctx, payload: { databaseId: string; backupId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db || db.status !== 'available') {
    await q("UPDATE db_backups SET status = 'failed', error = 'database not available', finished_at = now() WHERE id = $1", [payload.backupId]);
    return;
  }
  await q("UPDATE db_backups SET status = 'running' WHERE id = $1", [payload.backupId]);
  await changed(db.workspace_id, 'database', db.id);
  await mkdir(backupDir(db.id), { recursive: true });
  const file = path.join(backupDir(db.id), `${payload.backupId}.tar.gz`);
  dbLog(db, '==> Starting backup');
  const c = new pg.Client({ host: db.host, port: db.port, user: db.db_user, password: decrypt(db.password_enc), database: db.db_name });
  try {
    if (ctx.driver.name === 'docker') throw new Error('docker backups use pg_dump via the container (not implemented on this node)');
    await c.connect();
    const start = await c.query("SELECT pg_walfile_name(pg_backup_start('nav-' || $1, true)) AS wal, current_setting('server_version_num')::int / 10000 AS version", [payload.backupId]);
    const pack = tar.pack();
    const out = pipeline(pack, createGzip({ level: 6 }), createWriteStream(file));
    const root = dataDir(db.id);
    const entry = (name: string, buf: Buffer) => new Promise<void>((res, rej) => pack.entry({ name, size: buf.length }, buf, (err) => (err ? rej(err) : res())));
    await walkDir(root, '', skipLive, async (r) => { pack.entry({ name: r, type: 'directory' }); }, entry);
    // A backup must not wait forever for a broken archive_command.
    await c.query("SET statement_timeout = '10min'");
    const stop = await c.query('SELECT labelfile, spcmapfile FROM pg_backup_stop(true)');
    await entry('backup_label', Buffer.from(stop.rows[0].labelfile));
    for (const d of EMPTY_DIRS) pack.entry({ name: d, type: 'directory' });
    // WAL written during the backup (required for a consistent restore).
    await walkDir(root, 'pg_wal', (r) => r.startsWith('pg_wal/archive_status') || r.startsWith('pg_wal/summaries'), async () => {}, entry);
    pack.finalize();
    await out;
    const size = (await stat(file)).size;
    await q("UPDATE db_backups SET status = 'completed', path = $2, size_bytes = $3, wal_start = $4, pg_version = $5, finished_at = now() WHERE id = $1", [payload.backupId, file, size, start.rows[0].wal, start.rows[0].version]);
    dbLog(db, `==> Backup completed (${(size / 1048576).toFixed(1)} MB)`);
    await pruneWalArchive(db).catch((err) => dbLog(db, `==> WAL archive pruning failed: ${err.message}`, 'warn'));
  } catch (err) {
    await c.query('SELECT pg_backup_stop(false)').catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    await q("UPDATE db_backups SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [payload.backupId, (err as Error).message]);
    dbLog(db, `==> Backup failed: ${(err as Error).message}`, 'error');
  } finally {
    await c.end().catch(() => {});
    await changed(db.workspace_id, 'database', db.id);
  }
}

/**
 * Removes archived WAL no longer needed for the PITR window: everything before the start of the newest base backup
 * that is older than the retention period (that backup is the base for the oldest restorable instant).
 */
export async function pruneWalArchive(db: Row): Promise<number> {
  const days = pitrRetentionDays(db.plan);
  const dir = archiveDir(db.id);
  if (!days || !existsSync(dir)) return 0;
  const base = await one(
    `SELECT wal_start FROM db_backups WHERE database_id = $1 AND status = 'completed' AND wal_start IS NOT NULL
     AND finished_at <= now() - make_interval(days => $2) ORDER BY finished_at DESC LIMIT 1`,
    [db.id, days],
  );
  if (!base) return 0;
  const cut = String(base.wal_start).slice(8);
  let removed = 0;
  for (const f of await readdir(dir)) {
    // Same rule as pg_archivecleanup: compare log/segment numbers, keep timeline history and .backup files.
    if (/^[0-9A-F]{24}(\.partial)?$/.test(f) && f.slice(8, 24) < cut) {
      await rm(path.join(dir, f), { force: true });
      removed++;
    }
  }
  return removed;
}

/** Extracts a tar.gz base backup into an (empty) data directory. */
export async function extractBackup(file: string, root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ex = tar.extract();
    ex.on('entry', (h, stream, next) => {
      const dest = path.resolve(root, h.name);
      if (!dest.startsWith(path.resolve(root))) { stream.resume(); return next(); }
      if (h.type === 'directory') { mkdir(dest, { recursive: true }).then(() => { stream.resume(); next(); }, reject); return; }
      const chunks: Buffer[] = [];
      stream.on('data', (d) => chunks.push(d as Buffer));
      stream.on('end', () => mkdir(path.dirname(dest), { recursive: true }).then(() => writeFile(dest, Buffer.concat(chunks), { mode: 0o600 })).then(() => next(), reject));
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    createReadStream(file).pipe(createGunzip()).pipe(ex);
  });
  for (const d of EMPTY_DIRS) await mkdir(path.join(root, d), { recursive: true });
}

export async function handleDbRestore(ctx: Ctx, payload: { databaseId: string; backupId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  const b = await one('SELECT * FROM db_backups WHERE id = $1', [payload.backupId]);
  if (!db || !b?.path) return;
  const root = dataDir(db.id);
  const aside = `${root}.pre-restore-${Date.now()}`;
  dbLog(db, `==> Restoring backup ${b.id} from ${b.created_at}`);
  try {
    if (ctx.driver.name === 'docker') throw new Error('restore is not supported on docker nodes yet');
    await stopReplicas(ctx, db).catch(() => {});
    await stopCluster(root);
    await rename(root, aside);
    await extractBackup(b.path, root);
    // The restored cluster re-uses WAL file names already archived from the discarded history.
    await resetPitr(db);
    const s = await spec(db, db.port);
    await writeConfig(s);
    await startCluster(s, (l) => dbLog(db, l));
    await rm(aside, { recursive: true, force: true }).catch(() => {});
    await setStatus(db, 'available');
    dbLog(db, '==> Restore completed');
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_restored', data: { backupId: b.id } });
    if (s.archiveDir) await queueBaseBackup(db);
    await rebuildReplicas(ctx, db).catch((err) => dbLog(db, `==> Replica rebuild failed: ${err.message}`, 'error'));
  } catch (err) {
    dbLog(db, `==> Restore failed, rolling back: ${(err as Error).message}`, 'error');
    if (existsSync(aside)) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rename(aside, root).catch(() => {});
      await startCluster(await spec(db, db.port)).catch(() => {});
    }
    await startReplicas(ctx, db).catch(() => {});
    await setStatus(db, 'available');
  }
}

// --- Point-in-time recovery ------------------------------------------------------------------------
// A NEW database is created from the newest base backup taken before the target time, replays archived WAL up to
// recovery_target_time and is promoted. The source database is untouched.

async function pitrOp(opId: string | undefined, status: string, data: Record<string, unknown> = {}, error: string | null = null): Promise<void> {
  if (!opId) return;
  await q(`UPDATE db_operations SET status = $2, data = data || $3, error = $4, finished_at = CASE WHEN $2 IN ('completed','failed') THEN now() END WHERE id = $1`, [opId, status, data, error]);
}

export async function handleDbRecover(ctx: Ctx, payload: { databaseId: string; sourceId: string; backupId: string; targetTime: string; operationId?: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  const src = await one('SELECT * FROM databases WHERE id = $1', [payload.sourceId]);
  const b = await one('SELECT * FROM db_backups WHERE id = $1', [payload.backupId]);
  if (!db || db.status === 'deleting') return;
  const root = dataDir(db.id);
  try {
    if (ctx.driver.name === 'docker') throw new Error('point-in-time recovery is not supported on docker nodes yet');
    if (!src || !b?.path || !existsSync(b.path)) throw new Error('the base backup for this recovery is no longer available');
    await pitrOp(payload.operationId, 'running');
    dbLog(db, `==> Recovering ${src.name} to ${payload.targetTime} from base backup ${b.id} (${b.finished_at})`);
    // Make sure every change up to now is in the archive: a commit after the target (so replay knows where to
    // stop) and a WAL switch, then wait for the archiver.
    if (src.status === 'available') {
      const c = await pgConnect(src).catch(() => null);
      if (c) {
        try {
          await c.query('SELECT txid_current()');
          const sw = await c.query('SELECT pg_walfile_name(pg_switch_wal()) AS f');
          const want = sw.rows[0].f as string;
          for (let i = 0; i < 60; i++) {
            const a = await c.query('SELECT last_archived_wal FROM pg_stat_archiver');
            const last = a.rows[0].last_archived_wal as string | null;
            if (last && last.slice(8) >= want.slice(8)) break;
            await sleep(1000);
          }
        } finally {
          await c.end().catch(() => {});
        }
      }
    }
    await stopCluster(root, 'immediate').catch(() => {});
    await rm(root, { recursive: true, force: true });
    await extractBackup(b.path, root);
    const port = db.port ?? (await freePort());
    let s = await spec(db, port, { recovery: { restoreDir: archiveDir(src.id), targetTime: payload.targetTime } });
    await writeConfig(s);
    await writeFile(path.join(root, 'recovery.signal'), '');
    try {
      await startCluster(s, (l) => dbLog(db, l));
    } catch (err) {
      // No commit after the target in the archive (source down): the end of the archive is the closest state.
      if (!/recovery ended before configured recovery target was reached/.test((err as Error).message)) throw err;
      dbLog(db, '==> No transaction after the target time was archived; recovering to the end of the archive', 'warn');
      s = await spec(db, port, { recovery: { restoreDir: archiveDir(src.id) } });
      await writeConfig(s);
      await startCluster(s, (l) => dbLog(db, l));
    }
    // Wait for replay to reach the target and the server to promote itself.
    let promoted = false;
    for (let i = 0; i < 600 && !promoted; i++) {
      const c = await pgConnect(db, port, 'postgres').catch(() => null);
      if (c) {
        promoted = !(await c.query('SELECT pg_is_in_recovery() AS r')).rows[0].r;
        if (!promoted && !s.recovery?.targetTime) await c.query('SELECT pg_promote(true, 60)').catch(() => {});
        await c.end().catch(() => {});
      }
      if (!promoted) await sleep(1000);
    }
    if (!promoted) throw new Error('recovery did not finish within 10 minutes');
    // Back to a normal primary configuration (no restore_command / target).
    const final = await spec(db, port);
    await writeConfig(final);
    await reloadCluster(root);
    await setStatus(db, 'available', { driver: 'process', node_id: ctx.nodeId, host: '127.0.0.1', port, pitr_enabled_at: final.archiveDir ? new Date().toISOString() : null });
    dbLog(db, `==> Recovered to ${payload.targetTime}; database is available on port ${port}`);
    await pitrOp(payload.operationId, 'completed', { port });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_recovered', data: { sourceId: src.id, targetTime: payload.targetTime, backupId: b.id } });
    if (final.archiveDir) await queueBaseBackup(db);
  } catch (err) {
    dbLog(db, `==> Recovery failed: ${(err as Error).message}`, 'error');
    await stopCluster(root, 'immediate').catch(() => {});
    await setStatus(db, 'failed');
    await pitrOp(payload.operationId, 'failed', {}, (err as Error).message.slice(0, 2000));
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_failed', data: { error: (err as Error).message.slice(0, 300) } });
  }
}

// --- Node startup / monitoring ---------------------------------------------------------------------

/** Starts clusters owned by this node that should be running (after a host reboot). */
export async function recoverDatabases(ctx: Ctx): Promise<void> {
  if (ctx.driver.name !== 'process') return;
  const dbs = await q("SELECT * FROM databases WHERE node_id = $1 AND status IN ('available','restoring')", [ctx.nodeId]);
  for (const db of dbs) {
    if (await isRunning(dataDir(db.id))) continue;
    await startCluster(await spec(db, db.port), (l) => dbLog(db, l)).catch((err) => dbLog(db, `==> Failed to start: ${err.message}`, 'error'));
  }
}

const logOffsets = new Map<string, number>();

/** Ships new lines of each cluster's server.log and samples postmaster usage. */
export async function monitorDatabases(ctx: Ctx): Promise<void> {
  if (ctx.driver.name !== 'process') return;
  const dbs = await q("SELECT * FROM databases WHERE node_id = $1 AND status = 'available'", [ctx.nodeId]);
  const pids: { db: Row; pid: string }[] = [];
  for (const db of dbs) {
    const logFile = path.join(dataDir(db.id), 'server.log');
    const st = await stat(logFile).catch(() => null);
    if (st) {
      const from = logOffsets.get(db.id) ?? Math.max(0, st.size - 4096);
      if (st.size > from) {
        const fh = await open(logFile, 'r');
        const buf = Buffer.alloc(Math.min(st.size - from, 256 * 1024));
        await fh.read(buf, 0, buf.length, from);
        await fh.close();
        for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) dbLog(db, line, /ERROR|FATAL|PANIC/.test(line) ? 'error' : /WARNING/.test(line) ? 'warn' : 'info');
        logOffsets.set(db.id, from + buf.length);
      } else if (st.size < from) logOffsets.set(db.id, 0);
    }
    const pidFile = await readFile(path.join(dataDir(db.id), 'postmaster.pid'), 'utf8').catch(() => null);
    if (pidFile) pids.push({ db, pid: pidFile.split(/\r?\n/)[0].trim() });
  }
  if (!pids.length) return;
  const usage = await ctx.driver.usage(pids.map((p) => p.pid));
  for (const { db, pid } of pids) {
    const u = usage.get(pid);
    if (u) await q('INSERT INTO metrics (service_id, instance_id, ts, cpu, mem_bytes) VALUES ($1,$1,now(),$2,$3)', [db.id, u.cpu, Math.round(u.memBytes)]);
  }
}

// --- Docker driver ---------------------------------------------------------------------------------

export async function dockerPullImage(image: string, log: (l: string) => void): Promise<void> {
  const Docker = (await import('dockerode')).default;
  const docker = new Docker();
  log(`==> Pulling ${image}`);
  await new Promise<void>((resolve, reject) => docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())))));
}

export async function dockerEnsureNetwork(workspaceId: string): Promise<void> {
  const Docker = (await import('dockerode')).default;
  const docker = new Docker();
  const network = `nav-${workspaceId}`;
  const nets = await docker.listNetworks({ filters: { name: [network] } });
  if (!nets.some((n) => n.Name === network)) await docker.createNetwork({ Name: network, Driver: 'bridge' });
}

/** Waits until a database answers on 127.0.0.1:port. */
export async function waitForPostgres(db: Row, port: number, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const c = await pgConnect(db, port, 'postgres', 2000).catch(() => null);
    if (c) {
      await c.end().catch(() => {});
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function dockerProvision(ctx: Ctx, db: Row): Promise<void> {
  const Docker = (await import('dockerode')).default;
  const docker = new Docker();
  try {
    await dockerPullImage(`postgres:${db.pg_version}`, (l) => dbLog(db, l));
    await dockerEnsureNetwork(db.workspace_id);
    const plan = DATABASE_PLANS.find((p) => p.id === db.plan);
    const port = db.port ?? (await freePort());
    const container = await docker.createContainer(dockerPostgresContainer(db as never, {
      password: decrypt(db.password_enc), port, volume: `nav-db-${db.id}`, version: db.pg_version, memoryMB: plan?.memoryMB ?? 256, cpu: plan?.cpu ?? 0.5,
    }));
    await container.start();
    await waitForPostgres(db, port);
    await setStatus(db, 'available', { driver: 'docker', node_id: ctx.nodeId, ref: container.id, host: '127.0.0.1', port });
    dbLog(db, '==> Database is available');
  } catch (err) {
    dbLog(db, `==> Provisioning failed: ${(err as Error).message}`, 'error');
    await setStatus(db, 'failed');
  }
}

async function dockerExecLifecycle(db: Row, action: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> {
  const Docker = (await import('dockerode')).default;
  const docker = new Docker();
  const c = docker.getContainer(`nav-db-${db.id}`);
  if (action === 'remove') {
    await c.remove({ force: true }).catch(() => {});
    await docker.getVolume(`nav-db-${db.id}`).remove().catch(() => {});
    // Volumes created by upgrades / failovers carry the database label.
    const vols = await docker.listVolumes({ filters: { label: [`nav.database=${db.id}`] } }).catch(() => null);
    for (const v of vols?.Volumes ?? []) await docker.getVolume(v.Name).remove().catch(() => {});
  } else if (action === 'start') await c.start().catch(() => {});
  else if (action === 'stop') await c.stop().catch(() => {});
  else await c.restart().catch(() => {});
}
