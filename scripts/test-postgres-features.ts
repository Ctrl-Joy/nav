// Integration tests for the advanced Postgres features (PITR, read replicas, HA failover, pooling, extensions,
// upgrades, insights / repack) against REAL throwaway PostgreSQL clusters. Nothing shared is touched: a private
// platform database and data directory are created in a temp folder and removed at the end.
//
// Usage:  node scripts/test-postgres-features.ts
// Optional: NAV_PG_BIN_DIRS=<bin dir of a full PostgreSQL install> enables the pg_basebackup and pg_upgrade /
// pg_dump paths (embedded-postgres only ships initdb / pg_ctl / postgres). Without it those steps are skipped.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'nav-pgtest-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const results: { name: string; ok: boolean | 'skip'; err?: string }[] = [];
/** PG_TEST_ONLY=<regex> runs only matching steps (plus the first one, which creates the database). */
const only = process.env.PG_TEST_ONLY ? new RegExp(process.env.PG_TEST_ONLY, 'i') : null;
async function step(name: string, fn: () => Promise<void | 'skip'>) {
  if (only && results.length && !only.test(name)) return;
  process.stdout.write(`  • ${name} ... `);
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ name, ok: r === 'skip' ? 'skip' : true });
    console.log(r === 'skip' ? '\x1b[33mskipped\x1b[0m' : `\x1b[32mok\x1b[0m (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, err: (err as Error).message });
    console.log(`\x1b[31mFAILED\x1b[0m\n    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

// --- Private platform database ------------------------------------------------------------------------
// Nothing that loads @nav/shared/config (db pool, agent utils) may be imported before NAV_DATABASE_URL is set,
// otherwise it would point at the default (shared dev) database.
const { initCluster, startCluster, stopCluster, pgInstalls, isRunning } = await import('../apps/control/src/lib/pgcluster.ts');
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const platformPort = await freePort();
const platformPassword = randomBytes(12).toString('hex');
const platformSpec = { dataDir: path.join(tmp, 'platform'), port: platformPort, superuser: 'nav', password: platformPassword, listen: '127.0.0.1' };
process.env.NAV_DATABASE_URL = `postgres://nav:${platformPassword}@127.0.0.1:${platformPort}/postgres`;
let platformStarted = false;
const stopPlatform = async () => {
  if (!platformStarted) return;
  await stopCluster(platformSpec.dataDir, 'immediate').catch(() => {});
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
};
process.on('uncaughtException', async (err) => { console.error(err); await stopPlatform(); process.exit(1); });
await initCluster(platformSpec);
await startCluster(platformSpec);
platformStarted = true;
process.env.NAV_DATA_DIR = path.join(tmp, 'data');
process.env.NAV_MASTER_KEY = randomBytes(32).toString('hex');
process.env.NAV_PG_FAILOVER_SECONDS = '3';
process.env.NAV_LOG_LEVEL = 'error';
const fullToolsDirs = process.env.NAV_PG_BIN_DIRS ?? '';
console.log(`NAV Postgres feature tests (temp dir ${tmp}, platform db on ${platformPort})`);
console.log(`PostgreSQL installs: ${(await pgInstalls(true)).map((i) => `${i.version}@${i.binDir}${i.embedded ? ' (embedded)' : ''}`).join(', ')}\n`);

/** Setup failures must still stop the throwaway platform cluster. */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.error('setup failed:', err);
    await stopPlatform();
    process.exit(1);
  }
}
const { migrate } = await guard(import('../apps/control/src/db/migrate.ts'));
const { one, q, pool } = await guard(import('../apps/control/src/db/pool.ts'));
const { buildApp } = await guard(import('../apps/control/src/http/app.ts'));
const dbs = await guard(import('../apps/control/src/agent/databases.ts'));
const feat = await guard(import('../apps/control/src/agent/pgfeatures.ts'));
const { flushLogs } = await guard(import('../apps/control/src/agent/util.ts'));
const pg = (await guard(import('pg'))).default;
await guard(migrate());

const nodeId = 'node_pgtest';
const ctx = { driver: { name: 'process', usage: async () => new Map() }, instances: null, nodeId } as never;
await guard(q("INSERT INTO nodes (id, hostname, driver, address, capacity, version, last_heartbeat) VALUES ($1,'test','process','127.0.0.1','{}','test',now())", [nodeId]));
await q('UPDATE nodes SET capabilities = $2 WHERE id = $1', [nodeId, await feat.detectCapabilities('process')]);

const HANDLERS: Record<string, (ctx: never, p: never) => Promise<void>> = {
  db_provision: dbs.handleDbProvision, db_reconfigure: dbs.handleDbReconfigure, db_restart: dbs.handleDbRestart, db_delete: dbs.handleDbDelete,
  db_backup: dbs.handleDbBackup, db_restore: dbs.handleDbRestore, db_recover: dbs.handleDbRecover,
  db_replica_create: feat.handleDbReplicaCreate, db_replica_delete: feat.handleDbReplicaDelete, db_ha_enable: feat.handleDbHaEnable,
  db_ha_disable: feat.handleDbHaDisable, db_pooler_start: feat.handleDbPoolerStart, db_pooler_stop: feat.handleDbPoolerStop,
  db_upgrade: feat.handleDbUpgrade, db_repack: feat.handleDbRepack,
};
/** A minimal agent loop: runs queued db_* jobs in order on this "node". */
async function runJobs(): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 100; i++) {
    const job = await one("UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1 WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND kind LIKE 'db\\_%' ORDER BY id LIMIT 1) RETURNING *", [nodeId]);
    if (!job) break;
    ran.push(job.kind);
    try {
      await HANDLERS[job.kind](ctx, job.payload as never);
      await q("UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1", [job.id]);
    } catch (err) {
      await q("UPDATE jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [job.id, (err as Error).message]);
      throw new Error(`job ${job.kind} threw: ${(err as Error).message}`);
    }
  }
  return ran;
}
async function dbLogs(dbId: string, n = 15): Promise<string> {
  await flushLogs();
  return (await q('SELECT message FROM logs WHERE database_id = $1 ORDER BY id DESC LIMIT $2', [dbId, n])).reverse().map((r) => `      | ${r.message}`).join('\n');
}

// --- API client (Fastify inject with a session cookie) -------------------------------------------------
const app = await guard(buildApp());
let cookie = '';
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await app.inject({ method: method as never, url: `/api/v1${p}`, payload: body === undefined ? undefined : (body as object), headers: { cookie, 'x-nav-csrf': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
  const set = res.headers['set-cookie'];
  for (const c of Array.isArray(set) ? set : set ? [set] : []) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}
const signup = await guard(api('POST', '/auth/signup', { email: `pg-${Date.now()}@nav.test`, password: 'correct-horse-battery-staple' }));
if (signup.status !== 201) await guard(Promise.reject(new Error(`signup ${signup.status} ${JSON.stringify(signup.data)}`)));
const ws = signup.data.workspaces[0].id;

async function connect(port: number, dbRow: any, database = dbRow.db_name) {
  const { decrypt } = await import('@nav/shared/crypto');
  const c = new pg.Client({ host: '127.0.0.1', port, user: dbRow.db_user, password: decrypt(dbRow.password_enc), database });
  await c.connect();
  return c;
}
const row = async (id: string) => (await one('SELECT * FROM databases WHERE id = $1', [id]))!;
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

let dbId = '';
const created: string[] = [];
try {
  await step('create a paid database: cluster with WAL archiving + pg_stat_statements, first base backup', async () => {
    const r = await api('POST', `/workspaces/${ws}/databases`, { name: 'shop', plan: 'basic-256mb', pgVersion: 17 });
    assert(r.status === 201, `create ${r.status}`);
    dbId = r.data.id;
    created.push(dbId);
    await runJobs();
    const d = await row(dbId);
    assert(d.status === 'available', `status ${d.status}\n${await dbLogs(dbId)}`);
    assert(d.pitr_enabled_at, 'pitr_enabled_at not set');
    const b = await one("SELECT * FROM db_backups WHERE database_id = $1 AND status = 'completed'", [dbId]);
    assert(b?.wal_start && b.pg_version === 17, `base backup missing wal_start/pg_version: ${JSON.stringify(b)}\n${await dbLogs(dbId)}`);
    const c = await connect(d.port, d);
    const s = (await c.query("SELECT current_setting('archive_mode') AS a, current_setting('shared_preload_libraries') AS p")).rows[0];
    await c.end();
    assert(s.a === 'on' && s.p.includes('pg_stat_statements'), `settings ${JSON.stringify(s)}`);
    const archived = await readdir(dbs.archiveDir(dbId));
    assert(archived.some((f) => /^[0-9A-F]{24}$/.test(f)), `no WAL segment archived: ${archived}`);
    const g = await api('GET', `/databases/${dbId}`);
    assert(g.data.highAvailability === false && g.data.connectionPooling === false, 'serializer fields');
  });

  await step('extensions: list allow-listed, CREATE / DROP, reject unsafe and missing ones', async () => {
    const l = await api('GET', `/databases/${dbId}/extensions`);
    assert(l.status === 200, `list ${l.status}`);
    const names = l.data.items.map((e: any) => e.name);
    for (const n of ['pgcrypto', 'uuid-ossp', 'citext', 'hstore', 'pg_trgm', 'earthdistance', 'pg_stat_statements']) assert(names.includes(n), `missing ${n}`);
    assert(!names.includes('plpython3u') && !names.includes('dblink'), 'non allow-listed extension listed');
    assert(l.data.items.find((e: any) => e.name === 'pg_stat_statements').ready === true, 'pg_stat_statements not ready');
    const c1 = await api('POST', `/databases/${dbId}/extensions`, { name: 'earthdistance' });
    assert(c1.status === 201 && c1.data.installedVersion, `create earthdistance ${c1.status} ${JSON.stringify(c1.data)}`);
    const after = await api('GET', `/databases/${dbId}/extensions`);
    assert(after.data.items.find((e: any) => e.name === 'cube').installedVersion, 'cube should be installed via CASCADE');
    const bad = await api('POST', `/databases/${dbId}/extensions`, { name: 'plpython3u' });
    assert(bad.status === 400, `unsafe extension ${bad.status}`);
    const gis = await api('POST', `/databases/${dbId}/extensions`, { name: 'postgis' });
    assert(gis.status === 409, `postgis (not installed) ${gis.status}`);
    const dep = await api('DELETE', `/databases/${dbId}/extensions/cube`);
    assert(dep.status === 409 && /cascade/.test(dep.data.error.message), `drop with dependents ${dep.status} ${JSON.stringify(dep.data)}`);
    const d1 = await api('DELETE', `/databases/${dbId}/extensions/earthdistance`);
    const d2 = await api('DELETE', `/databases/${dbId}/extensions/cube`);
    assert(d1.status === 204 && d2.status === 204, `drop ${d1.status} ${d2.status}`);
  });

  await step('insights: slow queries (pg_stat_statements), table sizes / bloat, repack with VACUUM FULL', async () => {
    const d = await row(dbId);
    const c = await connect(d.port, d);
    await c.query('CREATE TABLE bloaty (id int primary key, pad text)');
    await c.query("INSERT INTO bloaty SELECT g, repeat('x', 200) FROM generate_series(1, 20000) g");
    await c.query('DELETE FROM bloaty WHERE id % 4 <> 0');
    await c.query('ANALYZE bloaty');
    for (let i = 0; i < 5; i++) await c.query('SELECT count(*) FROM bloaty a JOIN bloaty b ON a.id = b.id');
    await c.end();
    const sq = await api('GET', `/databases/${dbId}/insights/slow-queries`);
    assert(sq.status === 200 && sq.data.items.length > 0, `slow queries ${sq.status} ${JSON.stringify(sq.data).slice(0, 300)}`);
    assert(sq.data.items.some((x: any) => /JOIN bloaty/.test(x.query) && x.calls >= 5), 'join query not in top list');
    const t = await api('GET', `/databases/${dbId}/insights/tables`);
    const bl = t.data.items.find((x: any) => x.table === 'bloaty');
    assert(bl && bl.deadTuples > 0 && bl.bloatBytes > 0, `bloat stats ${JSON.stringify(bl)}`);
    const missing = await api('POST', `/databases/${dbId}/repack`, { table: 'nope' });
    assert(missing.status === 404, `repack missing table ${missing.status}`);
    const rp = await api('POST', `/databases/${dbId}/repack`, { schema: 'public', table: 'bloaty' });
    assert(rp.status === 202, `repack ${rp.status}`);
    await runJobs();
    const op = await one('SELECT * FROM db_operations WHERE id = $1', [rp.data.id]);
    assert(op.status === 'completed' && op.data.method === 'vacuum_full' && op.data.afterBytes < op.data.beforeBytes, `repack op ${JSON.stringify(op)}`);
    const ops = await api('GET', `/databases/${dbId}/operations`);
    assert(ops.data.items[0].kind === 'repack', 'operations list');
    const reset = await api('POST', `/databases/${dbId}/insights/slow-queries/reset`);
    assert(reset.status === 200, 'reset');
  });

  let recoveredId = '';
  await step('point-in-time recovery: window, validation, recover into a NEW database at a past instant', async () => {
    const d = await row(dbId);
    const c = await connect(d.port, d);
    await c.query('CREATE TABLE items (label text)');
    await c.query("INSERT INTO items VALUES ('before')");
    await sleep(1500);
    const target = new Date().toISOString();
    await sleep(1500);
    await c.query("INSERT INTO items VALUES ('after')");
    await c.query("UPDATE items SET label = 'changed' WHERE label = 'before'");
    await c.end();
    const w = await api('GET', `/databases/${dbId}/recovery`);
    assert(w.status === 200 && w.data.enabled && w.data.earliest && w.data.retentionDays === 3, `window ${JSON.stringify(w.data)}`);
    assert(new Date(w.data.earliest) < new Date(target), 'earliest must precede the target');
    const tooOld = await api('POST', `/databases/${dbId}/recover`, { targetTime: '2001-01-01T00:00:00Z' });
    assert(tooOld.status === 400, `too old ${tooOld.status}`);
    const future = await api('POST', `/databases/${dbId}/recover`, { targetTime: new Date(Date.now() + 3600e3).toISOString() });
    assert(future.status === 400, `future ${future.status}`);
    const r = await api('POST', `/databases/${dbId}/recover`, { targetTime: target });
    assert(r.status === 202 && r.data.status === 'restoring' && r.data.recoveredFrom?.databaseId === dbId, `recover ${r.status} ${JSON.stringify(r.data)}`);
    recoveredId = r.data.id;
    created.push(recoveredId);
    await runJobs();
    const n = await row(recoveredId);
    if (n.status !== 'available') {
      const failedOp = await one("SELECT error FROM db_operations WHERE database_id = $1 AND kind = 'recover'", [recoveredId]);
      const serverLog = await readFile(path.join(dbs.dataDir(recoveredId), 'server.log'), 'utf8').catch((e) => `(no server.log: ${e.message})`);
      throw new Error(`recovered status ${n.status}: ${failedOp?.error}\n${await dbLogs(recoveredId, 30)}\n--- server.log ---\n${serverLog.slice(-3000)}`);
    }
    const rc = await connect(n.port, n);
    const labels = (await rc.query('SELECT label FROM items ORDER BY 1')).rows.map((x) => x.label);
    const inRecovery = (await rc.query('SELECT pg_is_in_recovery() AS r')).rows[0].r;
    await rc.query("INSERT INTO items VALUES ('writable')");
    await rc.end();
    assert(JSON.stringify(labels) === '["before"]', `recovered rows ${JSON.stringify(labels)} (want ["before"])`);
    assert(!inRecovery, 'recovered database must be promoted');
    const op = await one("SELECT * FROM db_operations WHERE database_id = $1 AND kind = 'recover'", [recoveredId]);
    assert(op.status === 'completed', `recover op ${JSON.stringify(op)}`);
    const src = await row(dbId);
    const sc = await connect(src.port, src);
    const srcLabels = (await sc.query('SELECT label FROM items ORDER BY 1')).rows.map((x) => x.label);
    await sc.end();
    assert(JSON.stringify(srcLabels) === '["after","changed"]', `source must be untouched: ${JSON.stringify(srcLabels)}`);
  });

  await step('point-in-time recovery: free databases have no PITR (409 with reason)', async () => {
    const f = await one(
      `INSERT INTO databases (id, workspace_id, name, slug, plan, db_name, db_user, password_enc, status) SELECT 'dpg_freetest', workspace_id, 'free', 'free-test-db', 'free', db_name, db_user, password_enc, 'available' FROM databases WHERE id = $1 RETURNING *`,
      [dbId],
    );
    const w = await api('GET', `/databases/${f.id}/recovery`);
    assert(w.data.enabled === false && /paid/.test(w.data.reason), `free window ${JSON.stringify(w.data)}`);
    const r = await api('POST', `/databases/${f.id}/recover`, { targetTime: new Date().toISOString() });
    assert(r.status === 409, `free recover ${r.status}`);
    const ha = await api('PATCH', `/databases/${f.id}`, { highAvailability: true });
    assert(ha.status === 409, `free HA ${ha.status}`);
    const rep = await api('POST', `/databases/${f.id}/replicas`, {});
    assert(rep.status === 409, `free replica ${rep.status}`);
    await q('DELETE FROM databases WHERE id = $1', [f.id]);
  });

  let replica1 = '';
  await step('read replica via pg_basebackup -R: streams, read-only, lag reported, own connection string', async () => {
    if (!(await feat.detectCapabilities('process')).postgres.some((p) => p.pgBasebackup)) return 'skip';
    const r = await api('POST', `/databases/${dbId}/replicas`, { name: 'reports' });
    assert(r.status === 201 && r.data.status === 'creating', `create replica ${r.status}`);
    replica1 = r.data.id;
    await runJobs();
    const rep = await one('SELECT * FROM db_replicas WHERE id = $1', [replica1]);
    assert(rep.status === 'available', `replica ${rep.status} ${rep.error}\n${await dbLogs(dbId)}`);
    await flushLogs();
    assert(await one("SELECT 1 FROM logs WHERE database_id = $1 AND message LIKE '%[replica reports]%Cloning the primary with pg_basebackup%'", [dbId]), 'expected the pg_basebackup path');
    const d = await row(dbId);
    const pc = await connect(d.port, d);
    await pc.query("INSERT INTO items VALUES ('replicated')");
    await pc.end();
    const rc = await connect(rep.port, d);
    await waitFor('row on replica', async () => (await rc.query("SELECT 1 FROM items WHERE label = 'replicated'")).rowCount);
    const ro = await rc.query("INSERT INTO items VALUES ('x')").then(() => 'wrote', (e) => e.message);
    await rc.end();
    assert(/read-only/.test(ro), `replica must be read-only: ${ro}`);
    const l = await api('GET', `/databases/${dbId}/replicas`);
    const item = l.data.items.find((x: any) => x.id === replica1);
    assert(item.state === 'streaming' && typeof item.lagBytes === 'number', `lag ${JSON.stringify(item)}`);
    const creds = await api('GET', `/databases/${dbId}/credentials`);
    assert(creds.data.replicas.length === 1 && creds.data.replicas[0].externalUrl.includes(`:${rep.port}/`), `replica creds ${JSON.stringify(creds.data.replicas)}`);
  });

  await step('read replica without pg_basebackup (embedded binaries only): online copy + slot, then delete', async () => {
    process.env.NAV_PG_BIN_DIRS = '';
    await pgInstalls(true);
    try {
      const r = await api('POST', `/databases/${dbId}/replicas`, { name: 'copy' });
      assert(r.status === 201, `create ${r.status}`);
      await runJobs();
      const rep = await one('SELECT * FROM db_replicas WHERE id = $1', [r.data.id]);
      assert(rep.status === 'available', `replica ${rep.status} ${rep.error}\n${await dbLogs(dbId, 30)}`);
      await flushLogs();
      assert(await one("SELECT 1 FROM logs WHERE database_id = $1 AND message LIKE '%[replica copy]%online base backup%'", [dbId]), 'expected the copy path');
      const d = await row(dbId);
      const pc = await connect(d.port, d);
      await pc.query("INSERT INTO items VALUES ('copy-path')");
      const rc = await connect(rep.port, d);
      await waitFor('row on copy replica', async () => (await rc.query("SELECT 1 FROM items WHERE label = 'copy-path'")).rowCount);
      await rc.end();
      const del = await api('DELETE', `/databases/${dbId}/replicas/${r.data.id}`);
      assert(del.status === 204, `delete ${del.status}`);
      await runJobs();
      assert(!(await one('SELECT 1 FROM db_replicas WHERE id = $1', [r.data.id])), 'row still there');
      const slot = await pc.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [rep.slot_name]);
      await pc.end();
      assert(!slot.rowCount, 'replication slot must be dropped');
      assert(!existsSync(feat.replicaDir(dbId, r.data.id)), 'replica directory must be removed');
    } finally {
      process.env.NAV_PG_BIN_DIRS = fullToolsDirs;
      await pgInstalls(true);
    }
  });

  await step('high availability: standby built on PATCH, primary killed → promoted after ~3 s, same port, new standby', async () => {
    const before = await row(dbId);
    const toFree = await api('PATCH', `/databases/${dbId}`, { highAvailability: true, plan: 'free' });
    assert(toFree.status === 409, `HA on free ${toFree.status}`);
    const r = await api('PATCH', `/databases/${dbId}`, { highAvailability: true });
    assert(r.status === 200 && r.data.highAvailability === true, `enable ${r.status}`);
    await runJobs();
    const sb = await one("SELECT * FROM db_replicas WHERE database_id = $1 AND role = 'standby'", [dbId]);
    assert(sb?.status === 'available', `standby ${sb?.status} ${sb?.error}\n${await dbLogs(dbId)}`);
    const delSb = await api('DELETE', `/databases/${dbId}/replicas/${sb.id}`);
    assert(delSb.status === 409, 'standby must not be deletable as a replica');
    const pc = await connect(before.port, before);
    await pc.query("INSERT INTO items VALUES ('pre-failover')");
    await waitFor('standby caught up', async () => {
      const c = await connect(sb.port, before);
      const n = (await c.query("SELECT 1 FROM items WHERE label = 'pre-failover'")).rowCount;
      await c.end();
      return n;
    });
    await pc.end();
    // Healthy primary: the monitor must not fail over.
    await feat.monitorHighAvailability(ctx);
    // Kill the primary.
    await stopCluster(dbs.dataDir(dbId), 'immediate');
    const t0 = Date.now();
    await waitFor('failover', async () => {
      await feat.monitorHighAvailability(ctx);
      return one("SELECT * FROM events WHERE database_id = $1 AND kind = 'database_failover'", [dbId]);
    }, 60_000);
    const elapsed = (Date.now() - t0) / 1000;
    const after = await row(dbId);
    assert(after.port === before.port, `port changed ${before.port} → ${after.port}`);
    const nc = await connect(after.port, after);
    const st = (await nc.query("SELECT pg_is_in_recovery() AS r, (SELECT count(*)::int FROM items WHERE label = 'pre-failover') AS n")).rows[0];
    await nc.query("INSERT INTO items VALUES ('post-failover')");
    await nc.end();
    assert(!st.r && st.n === 1, `new primary ${JSON.stringify(st)}`);
    assert(existsSync(path.join(dbs.dbRoot(dbId), 'data.failed')), 'old primary data kept aside');
    const op = await one("SELECT * FROM db_operations WHERE database_id = $1 AND kind = 'failover'", [dbId]);
    assert(op.status === 'completed' && op.data.portChanged === false, `failover op ${JSON.stringify(op)}`);
    console.log(`\n    (failover detected+completed in ${elapsed.toFixed(1)}s after the kill)`);
    // The queued db_ha_enable rebuilds redundancy.
    await runJobs();
    const sb2 = await one("SELECT * FROM db_replicas WHERE database_id = $1 AND role = 'standby'", [dbId]);
    assert(sb2 && sb2.id !== sb.id && sb2.status === 'available', `new standby ${JSON.stringify(sb2)}`);
    assert(!existsSync(path.join(dbs.dbRoot(dbId), 'data.failed')), 'old primary data removed once redundancy is back');
    if (replica1) {
      const rep = await one('SELECT * FROM db_replicas WHERE id = $1', [replica1]);
      const rc = await connect(rep.port, after);
      await waitFor('read replica follows the new primary', async () => (await rc.query("SELECT 1 FROM items WHERE label = 'post-failover'")).rowCount, 30_000);
      await rc.end();
    }
  });

  await step('connection pooling: 409 with install instructions when PgBouncer is missing', async () => {
    const caps = await feat.detectCapabilities('process');
    if (caps.pgbouncer) return 'skip';
    const g = await api('GET', `/databases/${dbId}/pooler`);
    assert(g.status === 200 && g.data.available === false && /PgBouncer/.test(g.data.reason), `pooler ${JSON.stringify(g.data)}`);
    const p = await api('POST', `/databases/${dbId}/pooler`);
    assert(p.status === 409 && /install pgbouncer/.test(p.data.error.message), `enable ${p.status} ${JSON.stringify(p.data)}`);
  });

  await step('upgrades: API lists no targets (only one major installed) and refuses with a clear 409', async () => {
    const g = await api('GET', `/databases/${dbId}/upgrade`);
    assert(g.status === 200 && g.data.currentVersion === 17, `info ${JSON.stringify(g.data)}`);
    if (g.data.targets.length) return 'skip';
    assert(/No newer PostgreSQL/.test(g.data.reason), `reason ${g.data.reason}`);
    const p = await api('POST', `/databases/${dbId}/upgrade`, { version: 18 });
    assert(p.status === 409, `upgrade ${p.status}`);
    const same = await api('POST', `/databases/${dbId}/upgrade`, { version: 17 });
    assert(same.status === 400, `same version ${same.status}`);
  });

  for (const method of ['pg_upgrade', 'dump_restore'] as const) {
    await step(`upgrade machinery (${method}) end to end: new cluster, data copied, switched in place, replicas rebuilt`, async () => {
      const t = await feat.upgradeTools(17, 17, method);
      if (!t || t.method !== method) return 'skip';
      const d = await row(dbId);
      const pc = await connect(d.port, d);
      await pc.query(`CREATE TABLE IF NOT EXISTS up_${method} (v text)`);
      await pc.query(`INSERT INTO up_${method} VALUES ('kept')`);
      await pc.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_reader') THEN CREATE ROLE app_reader LOGIN PASSWORD 'x'; END IF; END $$");
      const sysBefore = (await pc.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
      await pc.end();
      await q("UPDATE databases SET status = 'upgrading' WHERE id = $1", [dbId]);
      const op = await one("INSERT INTO db_operations (id, database_id, kind, data) VALUES ($1,$2,'upgrade','{}') RETURNING *", [`dbo_${method}`, dbId]);
      await feat.handleDbUpgrade(ctx, { databaseId: dbId, version: 17, operationId: op.id, method });
      const o = await one('SELECT * FROM db_operations WHERE id = $1', [op.id]);
      assert(o.status === 'completed' && o.data.method === method, `op ${JSON.stringify(o)}\n${await dbLogs(dbId, 40)}`);
      const after = await row(dbId);
      assert(after.status === 'available' && after.port === d.port, `status ${after.status} port ${after.port}`);
      const nc = await connect(after.port, after);
      const v = (await nc.query(`SELECT v FROM up_${method}`)).rows;
      const role = (await nc.query("SELECT 1 FROM pg_roles WHERE rolname = 'app_reader'")).rowCount;
      const sysAfter = (await nc.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
      const items = (await nc.query('SELECT count(*)::int AS n FROM items')).rows[0].n;
      await nc.end();
      assert(v.length === 1 && role === 1 && items > 0, `data after upgrade ${JSON.stringify({ v, role, items })}`);
      assert(sysAfter !== sysBefore, 'expected a new cluster (system identifier changed)');
      assert(!existsSync(path.join(dbs.dbRoot(dbId), 'data.pre-upgrade')), 'old cluster should be removed after success');
      const reps = await q('SELECT * FROM db_replicas WHERE database_id = $1', [dbId]);
      assert(reps.every((r) => r.status === 'available'), `replicas after upgrade ${JSON.stringify(reps.map((r) => [r.role, r.status, r.error]))}`);
      await runJobs(); // fresh base backup for the new PITR history
      const w = await api('GET', `/databases/${dbId}/recovery`);
      assert(w.data.earliest && new Date(w.data.earliest) > new Date(o.created_at), `PITR window restarted after upgrade: ${JSON.stringify(w.data)}`);
    });
  }

  await step('upgrade failure rolls back to the old cluster (target binaries missing)', async () => {
    const d = await row(dbId);
    const op = await one("INSERT INTO db_operations (id, database_id, kind, data) VALUES ('dbo_fail',$1,'upgrade','{}') RETURNING *", [dbId]);
    await feat.handleDbUpgrade(ctx, { databaseId: dbId, version: 99, operationId: op.id });
    const o = await one('SELECT * FROM db_operations WHERE id = $1', [op.id]);
    assert(o.status === 'failed' && /not installed/.test(o.error), `op ${JSON.stringify(o)}`);
    const after = await row(dbId);
    const c = await connect(after.port, after);
    await c.query('SELECT 1');
    await c.end();
    assert(after.pg_version === d.pg_version && after.status === 'available', 'unchanged');
  });

  await step('WAL archive pruning keeps only what the PITR window needs', async () => {
    const dir = dbs.archiveDir(dbId);
    const b = await one("SELECT * FROM db_backups WHERE database_id = $1 AND status = 'completed' AND wal_start IS NOT NULL ORDER BY finished_at DESC LIMIT 1", [dbId]);
    const seg = parseInt(b.wal_start.slice(16), 16);
    const old = `${b.wal_start.slice(0, 16)}${Math.max(0, seg - 1).toString(16).toUpperCase().padStart(8, '0')}`;
    const fakeOld = seg > 0 ? old : null;
    if (fakeOld) await writeFile(path.join(dir, fakeOld), 'x');
    await writeFile(path.join(dir, '00000009.history'), 'x');
    const d = await row(dbId);
    assert((await dbs.pruneWalArchive(d)) === 0, 'nothing is older than the window yet');
    await q("UPDATE db_backups SET finished_at = now() - interval '4 days' WHERE id = $1", [b.id]);
    const removed = await dbs.pruneWalArchive(d);
    const left = await readdir(dir);
    assert(removed >= (fakeOld ? 1 : 0) && (!fakeOld || !left.includes(fakeOld)), `prune removed ${removed}`);
    assert(left.includes('00000009.history') && left.includes(b.wal_start) === existsSync(path.join(dir, b.wal_start)), 'history files are kept');
  });
} finally {
  console.log('\nCleaning up…');
  for (const id of created) await dbs.handleDbDelete(ctx, { databaseId: id }).catch((e) => console.error('cleanup', id, e.message));
  await flushLogs().catch(() => {});
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  await stopCluster(platformSpec.dataDir, 'immediate');
  const leftover = await isRunning(platformSpec.dataDir);
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  console.log(`Temp dir removed: ${!existsSync(tmp)}; platform cluster stopped: ${!leftover}`);
}

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === 'skip');
console.log(`\n${results.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
