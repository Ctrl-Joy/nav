// End to end: sandboxes through the real API, the @nav/sandbox SDK and a node agent running the process driver in
// a temp dir, against a private PostgreSQL cluster (embedded-postgres binaries) on a spare port.
// create -> exec (stdout / stderr / exit codes / stdin / env / truncation / timeout kill) -> streaming exec ->
// files up and down (with confinement) -> audit -> snapshot -> restore into a new sandbox -> limits -> TTL expiry.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { NavSandboxes as Client, SandboxHandle } from '@nav/sandbox';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const PG_PORT = Number(process.env.NAV_TEST_PG_PORT_SANDBOX ?? (await freePort()));
const API_PORT = await freePort();
const PASSWORD = 'navtest';
const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-sandbox-test-'));
process.env.NAV_DATABASE_URL = `postgres://nav:${PASSWORD}@127.0.0.1:${PG_PORT}/postgres`;
process.env.NAV_MASTER_KEY ??= 'a'.repeat(64);
process.env.NAV_DATA_DIR = path.join(dir, 'nav');
process.env.NAV_API_PORT = String(API_PORT);
process.env.NAV_CONTROL_URL = `http://127.0.0.1:${API_PORT}`;

const cluster = await import('../src/lib/pgcluster.ts');
const spec = { dataDir: path.join(dir, 'pg'), port: PG_PORT, superuser: 'nav', password: PASSWORD, listen: '127.0.0.1' };

let app: FastifyInstance;
let agent: Server;
let db: typeof import('../src/db/pool.ts');
let lib: typeof import('../src/lib/sandboxes.ts');
let nav: Client;
let workspaceId = '';
let token = '';
const opened: SandboxHandle[] = [];
const sandboxDir = (id: string) => path.join(dir, 'nav', 'sandboxes', id);

before(async () => {
  await cluster.initCluster(spec);
  await cluster.startCluster(spec);
  db = await import('../src/db/pool.ts');
  lib = await import('../src/lib/sandboxes.ts');
  await (await import('../src/db/migrate.ts')).migrate();
  app = await (await import('../src/http/app.ts')).buildApp();
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  // A node agent with only its sandbox endpoints, on the process driver.
  const { SandboxManager } = await import('../src/agent/sandbox/manager.ts');
  const { processSandboxDriver } = await import('../src/agent/sandbox/process.ts');
  const { createAgentServer } = await import('../src/agent/sandbox/server.ts');
  agent = createAgentServer(new SandboxManager(processSandboxDriver()), (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
  const agentPort = (agent.address() as net.AddressInfo).port;
  await db.q("INSERT INTO nodes (id, hostname, driver, address, agent_port, last_heartbeat) VALUES ('node_sbxtest', 'test', 'process', '127.0.0.1', $1, now())", [agentPort]);

  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email: 'dev@sandbox.test', password: 'correct horse battery' } });
  assert.equal(signup.statusCode, 201, signup.body);
  const cookie = signup.cookies.find((c) => c.name === 'nav_session')!;
  const workspaces = await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: { cookie: `nav_session=${cookie.value}` } });
  workspaceId = JSON.parse(workspaces.body).items[0].id;
  const key = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: { cookie: `nav_session=${cookie.value}`, 'x-nav-csrf': '1' }, payload: { name: 'sdk' } });
  assert.equal(key.statusCode, 201, key.body);
  const { NavSandboxes } = await import('@nav/sandbox');
  token = JSON.parse(key.body).token;
  nav = new NavSandboxes({ host: `http://127.0.0.1:${API_PORT}`, token, workspaceId });
});

after(async () => {
  for (const sb of opened) await sb.delete().catch(() => {});
  await app?.close();
  await new Promise((r) => (agent ? agent.close(r) : r(null)));
  await db?.pool.end();
  await cluster.stopCluster(spec.dataDir, 'immediate').catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function create(opts: Parameters<Client['create']>[0] = {}): Promise<SandboxHandle> {
  const sb = await nav.create(opts);
  opened.push(sb);
  return sb;
}

let main: SandboxHandle;

test('create a sandbox', async () => {
  main = await create({ name: 'agent-run', runtime: 'bash', ttlSeconds: 600, env: { FOO: 'from-create' } });
  assert.equal(main.info.status, 'running');
  assert.equal(main.info.driver, 'process');
  assert.equal(main.info.isolated, false);
  assert.deepEqual(main.info.envKeys, ['FOO']);
  assert.ok(existsSync(path.join(sandboxDir(main.id), 'workspace')));
  const list = await nav.list({ status: 'live' });
  assert.ok(list.some((s) => s.id === main.id));
  await assert.rejects(nav.create({ ttlSeconds: 5 }), (e: { status: number }) => e.status === 400);
  await assert.rejects(nav.create({ plan: 'huge' }), (e: { status: number }) => e.status === 400);
});

test('exec returns exit code, stdout and stderr', async () => {
  const r = await main.exec(`node -e "process.stdout.write('out');process.stderr.write('err');process.exit(3)"`);
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
  assert.equal(r.timedOut, false);
  const ok = await main.exec('node -e "process.stdin.pipe(process.stdout)"', { stdin: 'piped input' });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'piped input');
});

test('exec sees only the sandbox and call env, never platform secrets', async () => {
  const r = await main.exec(`node -e "process.stdout.write(JSON.stringify([process.env.NAV_MASTER_KEY||null,process.env.NAV_DATABASE_URL||null,process.env.FOO||null,process.env.BAR||null]))"`, { env: { BAR: 'from-exec' } });
  assert.deepEqual(JSON.parse(r.stdout), [null, null, 'from-create', 'from-exec']);
});

test('exec output is truncated at the limit', async () => {
  const r = await main.exec(`node -e "process.stdout.write('x'.repeat(3*1024*1024))"`);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdoutTruncated, true);
  assert.equal(r.stdout.length, 1024 * 1024);
});

test('a timeout kills the command and everything it started', async () => {
  await main.writeFile('child.js', "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 2500); setInterval(() => {}, 1000);");
  await main.writeFile('parent.js', "require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'ignore' }); setInterval(() => {}, 1000);");
  const started = Date.now();
  const r = await main.exec('node parent.js', { timeoutSeconds: 1 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 10_000, 'returned promptly');
  await new Promise((res) => setTimeout(res, 3500));
  assert.ok(!(await main.listFiles()).some((f) => f.name === 'late.txt'), 'the grandchild was killed too');
});

test('streaming exec delivers output as it is produced', async () => {
  let out = '';
  let err = '';
  const dec = new TextDecoder();
  const r = await main.execStream(`node -e "console.log('one');setTimeout(()=>{console.error('two');process.exit(7)},300)"`, {
    onStdout: (c) => { out += dec.decode(c); },
    onStderr: (c) => { err += dec.decode(c); },
  });
  assert.equal(r.exitCode, 7);
  assert.equal(out.trim(), 'one');
  assert.equal(err.trim(), 'two');
});

test('files go up and down, confined to the sandbox', async () => {
  await main.writeFile('dir/hello.txt', 'hello sandbox');
  assert.equal(await main.readText('/workspace/dir/hello.txt'), 'hello sandbox');
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await main.writeFile('dir/bin.dat', bytes);
  assert.deepEqual(await main.readFile('dir/bin.dat'), bytes);
  // JSON content uploaded as JSON still arrives byte for byte.
  const r = await fetch(`${nav.host}/api/v1/sandboxes/${main.id}/files?path=cfg.json`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"a": 1}' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(await main.readText('cfg.json'), '{"a": 1}');

  const root = await main.listFiles('');
  assert.ok(root.some((f) => f.name === 'dir' && f.type === 'dir'));
  const sub = await main.listFiles('dir');
  assert.deepEqual(sub.map((f) => [f.name, f.path, f.size]).sort(), [['bin.dat', 'dir/bin.dat', 5], ['hello.txt', 'dir/hello.txt', 13]]);
  // The command sees the same files.
  assert.equal((await main.exec(`node -e "process.stdout.write(require('fs').readFileSync('dir/hello.txt','utf8'))"`)).stdout, 'hello sandbox');

  for (const bad of ['../escape.txt', 'dir/../../x', 'C:/Windows/win.ini', 'a\\b']) {
    await assert.rejects(main.writeFile(bad, 'x'), (e: { status: number }) => e.status === 400, bad);
    await assert.rejects(main.readFile(bad), (e: { status: number }) => e.status === 400, bad);
  }
  assert.ok(!existsSync(path.join(sandboxDir(main.id), 'escape.txt')));
  await assert.rejects(main.readFile('missing.txt'), (e: { status: number }) => e.status === 404);
  await assert.rejects(main.removeFile('dir'), (e: { status: number }) => e.status === 409);
  await main.removeFile('dir/bin.dat');
  await assert.rejects(main.readFile('dir/bin.dat'), (e: { status: number }) => e.status === 404);
});

test('every exec is audited with its command and exit code, never its output', async () => {
  const rows = await db.q("SELECT * FROM audit_logs WHERE action = 'sandbox.exec' AND target_id = $1 ORDER BY id", [main.id]);
  assert.ok(rows.length >= 6, `expected exec audit rows, got ${rows.length}`);
  const first = rows.find((r) => String(r.data.command).includes('process.exit(3)'))!;
  assert.equal(first.data.exitCode, 3);
  assert.equal(first.actor_kind, 'api_key');
  const timed = rows.find((r) => r.data.command === 'node parent.js')!;
  assert.equal(timed.data.timedOut, true);
  const streamed = rows.find((r) => r.data.mode === 'stream')!;
  assert.equal(streamed.data.exitCode, 7);
  for (const r of rows) assert.ok(!JSON.stringify(r.data).includes('piped input'), 'no stdin in the log');
  assert.ok(!rows.some((r) => 'stdout' in r.data || 'stderr' in r.data));
  const sb = await nav.get(main.id);
  assert.ok(sb.info.execCount >= 6);
});

test('snapshot, then restore into a new sandbox', async () => {
  const snap = await main.snapshot({ name: 'with-hello' });
  assert.equal(snap.status, 'completed');
  assert.ok((snap.sizeBytes ?? 0) > 0);
  assert.ok((await nav.snapshots()).some((s) => s.id === snap.id));
  const copy = await create({ snapshotId: snap.id, ttlSeconds: 300 });
  assert.equal(copy.info.fromSnapshotId, snap.id);
  assert.equal(copy.info.runtime, 'bash');
  assert.equal(await copy.readText('dir/hello.txt'), 'hello sandbox');
  assert.equal(await copy.readText('cfg.json'), '{"a": 1}');
  // Independent copies.
  await copy.writeFile('dir/hello.txt', 'changed');
  assert.equal(await main.readText('dir/hello.txt'), 'hello sandbox');
  await copy.delete();
  assert.equal((await copy.refresh()).status, 'stopped');
  assert.ok(!existsSync(sandboxDir(copy.id)));
  await assert.rejects(copy.exec('echo hi'), (e: { status: number }) => e.status === 409);
});

test('the per-workspace limit is enforced', async () => {
  await db.q('UPDATE workspaces SET sandbox_limit = 2 WHERE id = $1', [workspaceId]);
  try {
    const second = await create({ ttlSeconds: 120 });
    await assert.rejects(create({ ttlSeconds: 120 }), (e: { status: number; code: string }) => e.status === 429 && e.code === 'sandbox_limit');
    await second.delete();
  } finally {
    await db.q('UPDATE workspaces SET sandbox_limit = NULL WHERE id = $1', [workspaceId]);
  }
});

test('sandboxes expire at their TTL and are cleaned up', async () => {
  const short = await create({ ttlSeconds: 60 });
  await short.writeFile('x.txt', 'x');
  // A command running at expiry is killed with the sandbox.
  const running = short.exec(`node -e "setInterval(()=>{},1000)"`, { timeoutSeconds: 120 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 500));
  await db.q("UPDATE sandboxes SET expires_at = now() - interval '1 second' WHERE id = $1", [short.id]);
  assert.ok(await lib.expireSandboxes() >= 1);
  const after = await short.refresh();
  assert.equal(after.status, 'expired');
  assert.ok(after.stoppedAt);
  assert.ok(!existsSync(sandboxDir(short.id)), 'the sandbox directory is removed');
  const r = await running;
  assert.ok(r instanceof Error || r.exitCode !== 0, 'the running command did not survive');
  await assert.rejects(short.exec('echo hi'), (e: { status: number }) => e.status === 409);
  // Untouched: the main sandbox has hours left.
  assert.equal((await main.refresh()).status, 'running');
});

test('deleting a sandbox removes everything', async () => {
  await main.delete();
  assert.equal((await main.refresh()).status, 'stopped');
  assert.ok(!existsSync(sandboxDir(main.id)));
});
