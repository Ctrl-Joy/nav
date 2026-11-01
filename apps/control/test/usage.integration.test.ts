// Usage ledger (migration 018 triggers) and the month report / CSV, against a private PostgreSQL cluster
// (embedded-postgres binaries) on a spare port. Spans are inserted with explicit timestamps in March 2025.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const PORT = Number(process.env.NAV_TEST_PG_PORT ?? 5493);
const PASSWORD = 'navtest';
const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-usage-test-'));
process.env.NAV_DATABASE_URL = `postgres://nav:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
process.env.NAV_MASTER_KEY ??= 'a'.repeat(64);
process.env.NAV_DATA_DIR = path.join(dir, 'nav');

const cluster = await import('../src/lib/pgcluster.ts');
const spec = { dataDir: path.join(dir, 'pg'), port: PORT, superuser: 'nav', password: PASSWORD, listen: '127.0.0.1' };

let app: FastifyInstance;
let db: typeof import('../src/db/pool.ts');
let usage: typeof import('../src/lib/usage.ts');
let cookie = '';
let ws = '';
let other = '';

before(async () => {
  await cluster.initCluster(spec);
  await cluster.startCluster(spec);
  db = await import('../src/db/pool.ts');
  usage = await import('../src/lib/usage.ts');
  await (await import('../src/db/migrate.ts')).migrate();
  app = await (await import('../src/http/app.ts')).buildApp();
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email: 'ada@usage.test', password: 'correct horse battery' } });
  assert.equal(r.statusCode, 201, r.body);
  cookie = `nav_session=${r.cookies.find((c) => c.name === 'nav_session')!.value}`;
  ws = JSON.parse(r.body).workspaces[0].id;
  other = 'ws_other';
  await db.q("INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Other', 'other')", [other]);
});

after(async () => {
  await app?.close();
  await db?.pool.end();
  await cluster.stopCluster(spec.dataDir, 'immediate').catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const near = (actual: number, expected: number, eps = 0.01) => assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

async function service(id: string, workspace: string, plan: string, disk: object | null = null) {
  await db.q(
    `INSERT INTO services (id, workspace_id, name, slug, type, runtime, plan, disk, deploy_hook_token) VALUES ($1,$2,$3,$4,'web','node',$5,$6,'t')`,
    [id, workspace, `svc ${id}`, id, plan, disk ? JSON.stringify(disk) : null],
  );
  await db.q("INSERT INTO deploys (id, service_id, trigger) VALUES ($1, $2, 'manual')", [`dep_${id}`, id]);
}

const instance = (id: string, svc: string, from: string, to: string | null) =>
  db.q("INSERT INTO instances (id, service_id, deploy_id, node_id, driver, status, started_at, stopped_at) VALUES ($1,$2,$3,'node_1','process',$4,$5,$6)", [id, svc, `dep_${svc}`, to ? 'stopped' : 'healthy', from, to]);

/** Triggers open plan / disk periods at now(); move them into March 2025. */
const backdate = (kind: string, ref: string, from: string, to: string) =>
  db.q('UPDATE usage_periods SET started_at = $3, ended_at = $4 WHERE kind = $1 AND ref_id = $2', [kind, ref, from, to]);

test('the ledger records instances, disks, builds, bandwidth, databases and key values', async () => {
  await service('srv_a', ws, 'starter', { name: 'data', mountPath: '/data', sizeGB: 10 });
  await backdate('disk', 'srv_a', '2025-03-01T00:00:00Z', '2025-03-16T00:00:00Z');   // 360 h x 10 GB
  await instance('ins_1', 'srv_a', '2025-02-28T12:00:00Z', '2025-03-01T12:00:00Z');   // 12 h in March
  await instance('ins_2', 'srv_a', '2025-03-10T00:00:00Z', null);                     // stopped below
  await db.q("UPDATE instances SET status = 'stopped', stopped_at = '2025-03-11T00:00:00Z' WHERE id = 'ins_2'"); // 24 h
  // Plan change: instances placed afterwards are recorded with the new plan.
  await db.q("UPDATE services SET plan = 'standard' WHERE id = 'srv_a'");
  await instance('ins_3', 'srv_a', '2025-03-20T00:00:00Z', '2025-03-20T06:00:00Z');   // 6 h standard
  await instance('ins_x', 'srv_a', '2025-04-02T00:00:00Z', '2025-04-03T00:00:00Z');   // April: excluded

  // Builds: one successful (90 s), one failed during the build (30 s), one still building (not counted).
  await db.q("INSERT INTO deploys (id, service_id, trigger, status, started_at) VALUES ('dep_b1','srv_a','manual','build_in_progress','2025-03-10T00:00:00Z')");
  await db.q("UPDATE deploys SET build_finished_at = '2025-03-10T00:01:30Z', status = 'live' WHERE id = 'dep_b1'");
  await db.q("UPDATE deploys SET status = 'live', finished_at = now() WHERE id = 'dep_b1'"); // recorded once only
  await db.q("INSERT INTO deploys (id, service_id, trigger, status, started_at, finished_at) VALUES ('dep_b2','srv_a','manual','build_failed','2025-03-12T00:00:00Z','2025-03-12T00:00:30Z')");
  await db.q("INSERT INTO deploys (id, service_id, trigger, status, started_at) VALUES ('dep_b3','srv_a','manual','build_in_progress','2025-03-13T00:00:00Z')");

  // Bandwidth: the edge's upsert adds to a minute; deltas land on the UTC day.
  const edge = (minute: string, bytes: number) => db.q(
    `INSERT INTO http_metrics (service_id, minute, requests, bytes_out) VALUES ('srv_a', $1, 1, $2)
     ON CONFLICT (service_id, minute) DO UPDATE SET requests = http_metrics.requests + 1, bytes_out = http_metrics.bytes_out + EXCLUDED.bytes_out`,
    [minute, bytes],
  );
  await edge('2025-03-05T10:00:00Z', 1000);
  await edge('2025-03-05T10:00:00Z', 500);
  await edge('2025-02-28T23:59:00Z', 999); // February

  await db.q(`INSERT INTO databases (id, workspace_id, name, slug, plan, db_name, db_user, password_enc, disk_gb, status)
              VALUES ('db_1', $1, 'main db', 'main-db', 'basic-1gb', 'app', 'app', 'x', 5, 'available')`, [ws]);
  await backdate('database', 'db_1', '2025-03-01T00:00:00Z', '2025-03-02T00:00:00Z'); // 24 h, 5 GB
  await db.q("INSERT INTO key_values (id, workspace_id, name, slug, plan, password_enc) VALUES ('kv_1', $1, 'cache', 'cache-kv', 'starter', 'x')", [ws]);
  const none = await db.q("SELECT 1 FROM usage_periods WHERE ref_id = 'kv_1'");
  assert.equal(none.length, 0, 'not billed while creating');
  await db.q("UPDATE key_values SET status = 'available' WHERE id = 'kv_1'");
  await backdate('key_value', 'kv_1', '2025-03-05T00:00:00Z', '2025-03-05T10:00:00Z'); // 10 h

  // Another workspace's usage never leaks in.
  await service('srv_o', other, 'pro');
  await instance('ins_o', 'srv_o', '2025-03-01T00:00:00Z', '2025-03-31T00:00:00Z');

  const r = await usage.usageReport(ws, '2025-03', new Date('2026-01-01T00:00:00Z'));
  assert.equal(r.partial, false);
  assert.equal(r.disclaimer, 'estimate — NAV does not bill');
  near(r.totals.instanceHours, 42);
  assert.deepEqual(r.instanceHoursByPlan.map((p) => [p.plan, p.hours]), [['starter', 36], ['standard', 6]]);
  near(r.totals.buildMinutes, 2);
  assert.equal(r.totals.bandwidthBytes, 1500);
  near(r.totals.diskGBMonths, 3600 / 730, 0.001);
  near(r.totals.databaseHours, 24);
  near(r.totals.keyValueHours, 10);
  const expected = (7 * 36 + 25 * 6) / 730 + (3600 / 730) * 0.25 + (19 * 24) / 730 + (10 * 10) / 730;
  near(r.totals.estimatedCost, expected, 0.02);
  assert.equal(r.services.length, 1);
  assert.equal(r.services[0].name, 'svc srv_a');
  near(r.databases[0].storageGBMonths, (24 * 5) / 730, 0.001);

  assert.equal(r.daily.length, 31);
  const day = (d: string) => r.daily.find((x) => x.day === d)!;
  near(day('2025-03-01').instanceHours, 12);
  near(day('2025-03-10').instanceHours, 24);
  near(day('2025-03-20').instanceHours, 6);
  assert.equal(day('2025-03-05').bandwidthBytes, 1500);
  near(r.daily.reduce((a, d) => a + d.instanceHours, 0), 42);

  // Current month: open spans count up to "now" only, future days are omitted.
  await instance('ins_now', 'srv_a', '2025-05-01T00:00:00Z', null);
  const may = await usage.usageReport(ws, '2025-05', new Date('2025-05-03T12:00:00Z'));
  assert.equal(may.partial, true);
  near(may.totals.instanceHours, 60);
  assert.equal(may.daily.length, 3);
  near(may.daily[2].instanceHours, 12);
});

test('deleting a service keeps its usage and closes running instances', async () => {
  await db.q("UPDATE usage_periods SET started_at = '2025-03-25T00:00:00Z' WHERE ref_id = 'ins_now'");
  await db.q("DELETE FROM services WHERE id = 'srv_a'");
  const open = await db.q("SELECT ended_at FROM usage_periods WHERE ref_id = 'ins_now'");
  assert.ok(open[0].ended_at, 'closed on delete');
  const r = await usage.usageReport(ws, '2025-03', new Date('2026-01-01T00:00:00Z'));
  assert.equal(r.services[0].deleted, true);
  assert.equal(r.services[0].name, 'svc srv_a');
  near(r.totals.instanceHours, 42 + 7 * 24);
  assert.equal(r.totals.bandwidthBytes, 1500);
  const disk = await db.q("SELECT ended_at FROM usage_periods WHERE kind = 'disk' AND ref_id = 'srv_a'");
  assert.equal(disk.length, 1);
});

test('GET /workspaces/:ws/usage returns JSON and CSV, and validates the month', async () => {
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const json = await get(`/api/v1/workspaces/${ws}/usage?month=2025-03`);
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(JSON.parse(json.body).month, '2025-03');
  const csv = await get(`/api/v1/workspaces/${ws}/usage?month=2025-03&format=csv`);
  assert.equal(csv.statusCode, 200);
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  const lines = csv.body.trim().split('\n');
  assert.equal(lines[0], 'month,resource_type,resource_id,name,deleted,plan,hours,bandwidth_bytes,build_minutes,disk_gb_months,estimated_cost_usd');
  assert.ok(lines.some((l) => l.startsWith('2025-03,postgres,db_1,main db,false,basic-1gb,24')));
  assert.ok(lines.at(-1)!.startsWith('2025-03,total,'));
  assert.equal((await get(`/api/v1/workspaces/${ws}/usage?month=2025-13`)).statusCode, 400);
  assert.equal((await get(`/api/v1/workspaces/${other}/usage`)).statusCode, 404);
  // Viewers may not read usage.
  const v = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email: 'viewer@usage.test', password: 'correct horse battery' } });
  const vid = JSON.parse(v.body).user.id;
  await db.q("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')", [ws, vid]);
  const vr = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${ws}/usage`, headers: { cookie: `nav_session=${v.cookies.find((c) => c.name === 'nav_session')!.value}` } });
  assert.equal(vr.statusCode, 403);
});

test('the month query uses the workspace index', async () => {
  // The table is tiny here, so make the planner show which index it would use.
  const client = await db.pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const { rows } = await client.query(
      `EXPLAIN SELECT 1 FROM usage_periods WHERE workspace_id = $1 AND COALESCE(ended_at, 'infinity'::timestamptz) > $2::timestamptz AND started_at < $3::timestamptz`,
      [ws, '2025-03-01T00:00:00Z', '2025-04-01T00:00:00Z'],
    );
    assert.match(rows.map((p) => p['QUERY PLAN']).join('\n'), /usage_periods_ws_end/);
  } finally {
    await client.query('RESET enable_seqscan');
    client.release();
  }
});
