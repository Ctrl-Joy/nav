// Managed PostgreSQL on this node. Process driver: real clusters via initdb/pg_ctl. Docker driver: postgres images.
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import tar from 'tar-stream';
import { config } from '@nav/shared/config';
import { decrypt } from '@nav/shared/crypto';
import { DATABASE_PLANS } from '@nav/shared';
import { one, q, type Row } from '../db/pool.ts';
import { changed, recordEvent } from '../lib/core.ts';
import { initCluster, isRunning, reloadCluster, startCluster, stopCluster, writeConfig, type ClusterSpec } from '../lib/pgcluster.ts';
import type { Ctx } from './handlers.ts';
import { freePort, shipLog } from './util.ts';

const dbRoot = (id: string) => path.join(config.dataDir, 'databases', id);
const dataDir = (id: string) => path.join(dbRoot(id), 'data');
const backupDir = (id: string) => path.join(config.dataDir, 'backups', id);

function spec(db: Row, port: number): ClusterSpec {
  const plan = DATABASE_PLANS.find((p) => p.id === db.plan);
  return {
    dataDir: dataDir(db.id),
    port,
    superuser: db.db_user,
    password: decrypt(db.password_enc),
    listen: '*',
    allowList: (db.ip_allow_list ?? []).map((e: { cidr: string }) => e.cidr),
    memoryMB: plan?.memoryMB ?? 256,
  };
}

const dbLog = (db: Row, message: string, level = 'info') => shipLog({ databaseId: db.id, stream: 'system' }, message, level);

async function setStatus(db: Row, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const keys = Object.keys(extra);
  await q(`UPDATE databases SET status = $2${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')}, updated_at = now() WHERE id = $1`, [db.id, status, ...keys.map((k) => extra[k])]);
  await changed(db.workspace_id, 'database', db.id);
}

export async function handleDbProvision(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db || db.status === 'deleting') return;
  if (ctx.driver.name === 'docker') return dockerProvision(ctx, db);
  try {
    const port = db.port ?? (await freePort());
    const s = spec(db, port);
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
    await setStatus(db, 'available', { driver: 'process', node_id: ctx.nodeId, host: '127.0.0.1', port });
    dbLog(db, `==> Database is available on port ${port}`);
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_available' });
  } catch (err) {
    dbLog(db, `==> Provisioning failed: ${(err as Error).message}`, 'error');
    await setStatus(db, 'failed');
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_failed', data: { error: (err as Error).message.slice(0, 300) } });
  }
}

/** Re-applies config (IP allow list, memory) and reloads. */
export async function handleDbReconfigure(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db?.port || db.status !== 'available') return;
  if (ctx.driver.name === 'docker') return;
  await writeConfig(spec(db, db.port));
  await reloadCluster(dataDir(db.id));
  dbLog(db, '==> Configuration reloaded (access control updated)');
}

export async function handleDbSuspend(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'stop');
  else await stopCluster(dataDir(db.id));
  dbLog(db, '==> Database suspended');
  await setStatus(db, 'suspended');
}

export async function handleDbResume(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'start');
  else await startCluster(spec(db, db.port));
  dbLog(db, '==> Database resumed');
  await setStatus(db, 'available');
}

export async function handleDbRestart(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'restart');
  else {
    await stopCluster(dataDir(db.id));
    await startCluster(spec(db, db.port));
  }
  dbLog(db, '==> Database restarted');
  await setStatus(db, 'available');
}

export async function handleDbDelete(ctx: Ctx, payload: { databaseId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  if (!db) return;
  if (ctx.driver.name === 'docker') await dockerExecLifecycle(db, 'remove');
  else await stopCluster(dataDir(db.id), 'immediate').catch(() => {});
  await rm(dbRoot(db.id), { recursive: true, force: true }).catch(() => {});
  await rm(backupDir(db.id), { recursive: true, force: true }).catch(() => {});
  await q('DELETE FROM logs WHERE database_id = $1', [db.id]);
  await q('DELETE FROM metrics WHERE service_id = $1', [db.id]);
  await q('DELETE FROM blueprint_resources WHERE resource_id = $1', [db.id]);
  await q('DELETE FROM databases WHERE id = $1', [db.id]);
  await changed(db.workspace_id, 'database', db.id);
}

// --- Backups ---------------------------------------------------------------------------------------
// Process driver: online physical backup using the non-exclusive backup API (pg_backup_start/stop) — a
// consistent base backup including the WAL needed to recover it, packed as tar.gz.

async function addDir(pack: tar.Pack, root: string, rel: string, skip: (rel: string) => boolean): Promise<void> {
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    const full = path.join(root, r);
    if (e.isDirectory()) {
      pack.entry({ name: r, type: 'directory' });
      await addDir(pack, root, r, skip);
    } else if (e.isFile()) {
      const st = await stat(full).catch(() => null);
      if (!st) continue; // file vanished during backup (allowed by the backup protocol)
      const fh = await open(full, 'r');
      try {
        const buf = Buffer.alloc(st.size);
        await fh.read(buf, 0, st.size, 0);
        await new Promise<void>((res, rej) => pack.entry({ name: r, size: st.size }, buf, (err) => (err ? rej(err) : res())));
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
    await c.query("SELECT pg_backup_start('nav-' || $1, true)", [payload.backupId]);
    const pack = tar.pack();
    const out = pipeline(pack, createGzip({ level: 6 }), createWriteStream(file));
    const root = dataDir(db.id);
    const skipLive = (r: string) => /^(pg_wal\/|postmaster\.(pid|opts)$|server\.log$|pg_replslot\/|pg_stat_tmp\/|pg_dynshmem\/|pg_notify\/|pg_serial\/|pg_snapshots\/|pg_subtrans\/)/.test(r) || r === 'pg_wal';
    await addDir(pack, root, '', skipLive);
    const stop = await c.query('SELECT labelfile, spcmapfile FROM pg_backup_stop(true)');
    const label = Buffer.from(stop.rows[0].labelfile);
    pack.entry({ name: 'backup_label', size: label.length }, label);
    for (const d of ['pg_wal', 'pg_replslot', 'pg_stat_tmp', 'pg_dynshmem', 'pg_notify', 'pg_serial', 'pg_snapshots', 'pg_subtrans']) pack.entry({ name: d, type: 'directory' });
    // WAL written during the backup (required for a consistent restore).
    await addDir(pack, root, 'pg_wal', (r) => r.startsWith('pg_wal/archive_status'));
    pack.finalize();
    await out;
    const size = (await stat(file)).size;
    await q("UPDATE db_backups SET status = 'completed', path = $2, size_bytes = $3, finished_at = now() WHERE id = $1", [payload.backupId, file, size]);
    dbLog(db, `==> Backup completed (${(size / 1048576).toFixed(1)} MB)`);
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

export async function handleDbRestore(ctx: Ctx, payload: { databaseId: string; backupId: string }): Promise<void> {
  const db = await one('SELECT * FROM databases WHERE id = $1', [payload.databaseId]);
  const b = await one('SELECT * FROM db_backups WHERE id = $1', [payload.backupId]);
  if (!db || !b?.path) return;
  const root = dataDir(db.id);
  const aside = `${root}.pre-restore-${Date.now()}`;
  dbLog(db, `==> Restoring backup ${b.id} from ${b.created_at}`);
  try {
    if (ctx.driver.name === 'docker') throw new Error('restore is not supported on docker nodes yet');
    await stopCluster(root);
    await rename(root, aside);
    await mkdir(root, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const ex = tar.extract();
      ex.on('entry', (h, stream, next) => {
        const dest = path.resolve(root, h.name);
        if (!dest.startsWith(root)) { stream.resume(); return next(); }
        if (h.type === 'directory') { mkdir(dest, { recursive: true }).then(() => { stream.resume(); next(); }, reject); return; }
        const chunks: Buffer[] = [];
        stream.on('data', (d) => chunks.push(d as Buffer));
        stream.on('end', () => mkdir(path.dirname(dest), { recursive: true }).then(() => writeFile(dest, Buffer.concat(chunks), { mode: 0o600 })).then(() => next(), reject));
      });
      ex.on('finish', resolve);
      ex.on('error', reject);
      createReadStream(b.path).pipe(createGunzip()).pipe(ex);
    });
    await writeConfig(spec(db, db.port));
    await startCluster(spec(db, db.port), (l) => dbLog(db, l));
    await rm(aside, { recursive: true, force: true }).catch(() => {});
    await setStatus(db, 'available');
    dbLog(db, '==> Restore completed');
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, kind: 'database_restored', data: { backupId: b.id } });
  } catch (err) {
    dbLog(db, `==> Restore failed, rolling back: ${(err as Error).message}`, 'error');
    if (existsSync(aside)) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rename(aside, root).catch(() => {});
      await startCluster(spec(db, db.port)).catch(() => {});
    }
    await setStatus(db, 'available');
  }
}

// --- Node startup / monitoring ---------------------------------------------------------------------

/** Starts clusters owned by this node that should be running (after a host reboot). */
export async function recoverDatabases(ctx: Ctx): Promise<void> {
  if (ctx.driver.name !== 'process') return;
  const dbs = await q("SELECT * FROM databases WHERE node_id = $1 AND status IN ('available','restoring')", [ctx.nodeId]);
  for (const db of dbs) {
    if (await isRunning(dataDir(db.id))) continue;
    await startCluster(spec(db, db.port), (l) => dbLog(db, l)).catch((err) => dbLog(db, `==> Failed to start: ${err.message}`, 'error'));
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

async function dockerProvision(ctx: Ctx, db: Row): Promise<void> {
  const Docker = (await import('dockerode')).default;
  const docker = new Docker();
  try {
    const image = `postgres:${db.pg_version}`;
    dbLog(db, `==> Pulling ${image}`);
    await new Promise<void>((resolve, reject) => docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())))));
    const network = `nav-${db.workspace_id}`;
    const nets = await docker.listNetworks({ filters: { name: [network] } });
    if (!nets.some((n) => n.Name === network)) await docker.createNetwork({ Name: network, Driver: 'bridge' });
    const plan = DATABASE_PLANS.find((p) => p.id === db.plan);
    const port = db.port ?? (await freePort());
    const container = await docker.createContainer({
      name: `nav-db-${db.id}`,
      Image: image,
      Env: [`POSTGRES_USER=${db.db_user}`, `POSTGRES_PASSWORD=${decrypt(db.password_enc)}`, `POSTGRES_DB=${db.db_name}`, 'POSTGRES_INITDB_ARGS=--auth=scram-sha-256'],
      Labels: { 'nav.database': db.id },
      HostConfig: {
        NetworkMode: network,
        PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(port) }] },
        Mounts: [{ Type: 'volume', Source: `nav-db-${db.id}`, Target: '/var/lib/postgresql/data' }],
        Memory: (plan?.memoryMB ?? 256) * 1048576,
        NanoCpus: Math.round((plan?.cpu ?? 0.5) * 1e9),
        RestartPolicy: { Name: 'unless-stopped' },
        SecurityOpt: ['no-new-privileges:true'],
      },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [db.slug] } } },
    });
    await container.start();
    for (let i = 0; i < 60; i++) {
      const c = new pg.Client({ host: '127.0.0.1', port, user: db.db_user, password: decrypt(db.password_enc), database: db.db_name, connectionTimeoutMillis: 2000 });
      const ok = await c.connect().then(() => true, () => false);
      await c.end().catch(() => {});
      if (ok) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await setStatus(db, 'available', { driver: 'docker', node_id: ctx.nodeId, ref: container.id, host: '127.0.0.1', port });
    dbLog(db, '==> Database is available');
  } catch (err) {
    dbLog(db, `==> Provisioning failed: ${(err as Error).message}`, 'error');
    await setStatus(db, 'failed');
  }
}

async function dockerExecLifecycle(db: Row, action: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> {
  const Docker = (await import('dockerode')).default;
  const c = new Docker().getContainer(`nav-db-${db.id}`);
  if (action === 'remove') {
    await c.remove({ force: true }).catch(() => {});
    await new Docker().getVolume(`nav-db-${db.id}`).remove().catch(() => {});
  } else if (action === 'start') await c.start().catch(() => {});
  else if (action === 'stop') await c.stop().catch(() => {});
  else await c.restart().catch(() => {});
}
