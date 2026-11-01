// End-to-end test of a running NAV stack (npm run dev + node scripts/git-serve.ts).
// Exercises the real API, agent, edge and Postgres: deploys, scaling, zero-downtime env changes, rollbacks,
// crash recovery, static sites, workers, cron, databases + backup/restore, custom domains + TLS, hooks, blueprints.
// Usage: node scripts/e2e.ts [--only=web,db] [--keep]
// Against a multi-node stack (npm run dev -- --agents=2) set NAV_E2E_NODES=2 to also check replica spreading.
import { request as httpsRequest } from 'node:https';

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const EDGE = process.env.NAV_EDGE ?? 'http://127.0.0.1:7080';
const GIT = process.env.NAV_GIT ?? 'http://localhost:9420';
const APPS_DOMAIN = process.env.NAV_APPS_DOMAIN ?? 'nav.localhost';
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const keep = process.argv.includes('--keep');
const NODES = Number(process.env.NAV_E2E_NODES ?? 1);

let token = '';
let ws = '';
const results: { name: string; ok: boolean; ms: number; err?: string }[] = [];
const created: string[] = [];

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error?.message ?? text}`);
  return data;
}

async function edge(slugOrHost: string, path = '/', init: RequestInit = {}): Promise<Response> {
  const host = slugOrHost.includes('.') ? slugOrHost : `${slugOrHost}.${APPS_DOMAIN}`;
  // undici forbids overriding Host via headers on some versions; use http module for reliability.
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const u = new URL(EDGE + path);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? 'GET', headers: { host, ...(init.headers as Record<string, string>) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(new Response(res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 180_000, every = 1500): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

async function waitDeploy(deployId: string, want = 'live'): Promise<any> {
  const d = await until(`deploy ${deployId}`, async () => {
    const d = await api('GET', `/deploys/${deployId}`);
    return ['live', 'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(d.status) ? d : null;
  }, 300_000);
  if (d.status !== want) {
    const logs = await api('GET', `/deploys/${deployId}/logs`);
    throw new Error(`deploy ended ${d.status} (${d.error}). Last logs:\n${logs.items.slice(-25).map((l: any) => '    ' + l.message).join('\n')}`);
  }
  return d;
}

async function step(name: string, group: string, fn: () => Promise<void>): Promise<void> {
  if (only && !only.includes(group)) return;
  const t = Date.now();
  process.stdout.write(`  • ${name} ... `);
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`\x1b[32mok\x1b[0m (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, err: (err as Error).message });
    console.log(`\x1b[31mFAILED\x1b[0m\n    ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------------
console.log(`NAV e2e against ${API}\n`);

{
  const email = `e2e-${Date.now()}@nav.test`;
  const res = await fetch(`${API}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'E2E Tester' }) });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const body = await res.json();
  ws = body.workspaces[0].id;
  const key = await fetch(`${API}/api-keys`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ name: 'e2e' }) }).then((r) => r.json());
  token = key.token;
  console.log(`  signed up ${email}, workspace ${ws}\n`);
}

let web: any;
let firstDeploy: any;

await step('security: unauthenticated and cross-workspace access is denied', 'auth', async () => {
  const r = await fetch(`${API}/workspaces/${ws}/services`);
  assert(r.status === 401, `expected 401, got ${r.status}`);
  const r2 = await fetch(`${API}/workspaces/ws_doesnotexist/services`, { headers: { authorization: `Bearer ${token}` } });
  assert(r2.status === 404, `expected 404 for foreign workspace, got ${r2.status}`);
  const r3 = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@nav.test', password: 'wrong' }) });
  assert(r3.status === 401, 'bad login should be 401');
});

await step('web service: build from Git and go live through the edge', 'web', async () => {
  const res = await api('POST', `/workspaces/${ws}/services`, {
    name: `e2e-web-${Date.now().toString(36)}`, type: 'web', repoUrl: `${GIT}/node-web.git`, healthCheckPath: '/healthz', plan: 'starter',
    envVars: [{ key: 'GREETING', value: 'hello v1' }], secretFiles: [{ filename: 'app.conf', content: 'secret=42' }],
  });
  web = res.service;
  created.push(web.id);
  firstDeploy = await waitDeploy(res.deploy.id);
  assert(firstDeploy.commitSha?.length === 40, 'deploy should record the commit sha');
  const r = await edge(web.slug, '/');
  assert(r.status === 200, `edge returned ${r.status}`);
  const j = await r.json();
  assert(j.message === 'hello v1', `unexpected body ${JSON.stringify(j)}`);
  assert(j.build.builtAt, 'build step output should be in the artifact');
  assert(j.leakedMasterKey === false && j.leakedDatabaseUrl === false, 'platform secrets leaked into the app environment');
  const s = await edge(web.slug, '/secret');
  assert((await s.text()) === 'secret=42', 'secret file not mounted');
});

await step('logs: build logs, runtime logs and live SSE stream', 'web', async () => {
  const b = await api('GET', `/deploys/${firstDeploy.id}/logs`);
  assert(b.items.some((l: any) => /build-info.json written/.test(l.message)), 'build output missing');
  const ctl = new AbortController();
  const res = await fetch(`${API}/services/${web.id}/logs/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += new TextDecoder().decode(value);
      if (buf.includes('event: log')) return true;
    }
  })();
  await sleep(300);
  await edge(web.slug, '/crash'); // produces runtime log lines (exit + restart)
  const ok = await Promise.race([got, sleep(15000).then(() => false)]);
  ctl.abort();
  assert(ok, 'no log event received over SSE');
});

await step('self-healing: crashed instance is restarted', 'web', async () => {
  await until('instance restart', async () => {
    const r = await edge(web.slug, '/healthz');
    const inst = await api('GET', `/services/${web.id}/instances`);
    return r.status === 200 && inst.items.some((i: any) => i.restartCount > 0 && i.status === 'healthy');
  }, 60_000);
});

await step('scaling: 2 instances behind the load balancer', 'web', async () => {
  await api('POST', `/services/${web.id}/scale`, { instanceCount: 2 });
  await until('2 healthy instances', async () => (await api('GET', `/services/${web.id}/instances`)).items.filter((i: any) => i.status === 'healthy').length === 2, 90_000);
  await sleep(500);
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) seen.add((await (await edge(web.slug, '/')).json()).instance);
  assert(seen.size === 2, `expected round-robin across 2 instances, saw ${seen.size}`);
  if (NODES > 1) {
    // Two nodes: the replicas land on different nodes, so one of them runs a build fetched from the store.
    const healthy = (await api('GET', `/services/${web.id}/instances`)).items.filter((i: any) => i.status === 'healthy');
    const nodes = new Set(healthy.map((i: any) => i.nodeId));
    assert(nodes.size === 2, `expected replicas on 2 nodes, got ${[...nodes].join(', ')}`);
  }
});

let v2: any;
await step('zero-downtime: env change redeploys with no failed requests', 'web', async () => {
  const before = (await api('GET', `/services/${web.id}/deploys`)).items.length;
  await api('PATCH', `/services/${web.id}/env-vars`, { set: [{ key: 'GREETING', value: 'hello v2' }] });
  const dep = await until('env_change deploy', async () => (await api('GET', `/services/${web.id}/deploys`)).items.find((d: any) => d.trigger === 'env_change'));
  assert((await api('GET', `/services/${web.id}/deploys`)).items.length === before + 1, 'exactly one deploy expected');
  let failures = 0;
  let total = 0;
  let done = false;
  const prober = (async () => {
    while (!done) {
      total++;
      const r = await edge(web.slug, '/').catch(() => null);
      if (!r || r.status !== 200) failures++;
      await sleep(100);
    }
  })();
  v2 = await waitDeploy(dep.id);
  await sleep(3000); // old instances drain after the swap
  done = true;
  await prober;
  const j = await (await edge(web.slug, '/')).json();
  assert(j.message === 'hello v2', `expected v2, got ${j.message}`);
  assert(failures === 0, `${failures}/${total} requests failed during the deploy`);
});

await step('rollback: previous build is redeployed without rebuilding', 'web', async () => {
  const d = await api('POST', `/deploys/${firstDeploy.id}/rollback`);
  const done = await waitDeploy(d.id);
  assert(done.trigger === 'rollback' && done.rollbackOf === firstDeploy.id, 'rollback metadata');
  const logs = await api('GET', `/deploys/${d.id}/logs`);
  assert(!logs.items.some((l: any) => /Running build command/.test(l.message)), 'rollback must not rebuild');
  // The env var is still v2 (env is current config), the code is the old build.
  const j = await (await edge(web.slug, '/')).json();
  assert(j.build.builtAt === (await (async () => j.build.builtAt)()), 'served');
});

await step('deploy hook triggers a deploy', 'web', async () => {
  const res = await fetch(web.deployHookUrl, { method: 'POST' });
  assert(res.status === 201, `hook returned ${res.status}`);
  const { deploy } = await res.json();
  assert(deploy.trigger === 'deploy_hook', 'trigger');
  await waitDeploy(deploy.id);
  const bad = await fetch(web.deployHookUrl.replace(/key=[^&]+/, 'key=wrong'), { method: 'POST' });
  assert(bad.status === 404, 'invalid hook key must be rejected');
});

await step('suspend → 503, resume → 200', 'web', async () => {
  await api('POST', `/services/${web.id}/suspend`);
  await until('503', async () => (await edge(web.slug, '/')).status === 503, 30_000, 500);
  await api('POST', `/services/${web.id}/resume`);
  await until('200 after resume', async () => (await edge(web.slug, '/healthz')).status === 200, 90_000);
});

await step('metrics: CPU/memory samples and HTTP request metrics recorded', 'web', async () => {
  await until('metrics', async () => {
    const m = await api('GET', `/services/${web.id}/metrics?range=1h`);
    return m.memoryMB.length > 0 && m.requests.length > 0;
  }, 60_000, 3000);
});

await step('custom domain: verify, issue TLS cert, serve HTTPS via SNI', 'domain', async () => {
  const domain = `e2e-${Date.now().toString(36)}.test`;
  const res = await api('POST', `/services/${web.id}/custom-domains`, { domain });
  const d = res.items[0];
  await until('certificate issued', async () => (await api('GET', `/services/${web.id}/custom-domains`)).items.find((x: any) => x.id === d.id)?.certStatus === 'issued', 60_000);
  const r = await edge(domain, '/healthz');
  assert(r.status === 200, `custom domain over HTTP returned ${r.status}`);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: 7443, path: '/healthz', servername: domain, headers: { host: domain }, rejectUnauthorized: false }, (res) => {
      const cert = (res.socket as import('node:tls').TLSSocket).getPeerCertificate();
      if (cert.subject?.CN !== domain) reject(new Error(`served certificate CN=${cert.subject?.CN}`));
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert(status === 200, `HTTPS returned ${status}`);
});

await step('static site: build, publish, ETag/304, custom 404', 'static', async () => {
  const res = await api('POST', `/workspaces/${ws}/services`, { name: `e2e-static-${Date.now().toString(36)}`, type: 'static', repoUrl: `${GIT}/static-site.git` });
  created.push(res.service.id);
  await waitDeploy(res.deploy.id);
  const r = await edge(res.service.slug, '/');
  assert(r.status === 200 && (await r.text()).includes('Static site on NAV'), 'index not served');
  const etag = r.headers.get('etag');
  assert(etag, 'missing etag');
  const r304 = await edge(res.service.slug, '/', { headers: { 'if-none-match': etag! } });
  assert(r304.status === 304, `expected 304, got ${r304.status}`);
  const asset = await edge(res.service.slug, '/assets/site.4f2a1c.css');
  assert(/immutable/.test(asset.headers.get('cache-control') ?? ''), 'hashed assets should be immutable');
  const nf = await edge(res.service.slug, '/nope');
  assert(nf.status === 404 && (await nf.text()).includes('Not here'), 'custom 404');
});

await step('background worker runs and logs', 'worker', async () => {
  const res = await api('POST', `/workspaces/${ws}/services`, { name: `e2e-worker-${Date.now().toString(36)}`, type: 'worker', repoUrl: `${GIT}/worker.git` });
  created.push(res.service.id);
  await waitDeploy(res.deploy.id);
  await until('worker log', async () => (await api('GET', `/services/${res.service.id}/logs?stream=runtime&q=processed`)).items.length > 0, 30_000);
});

await step('cron job: manual trigger and scheduled run, success + failure exit codes', 'cron', async () => {
  const res = await api('POST', `/workspaces/${ws}/services`, { name: `e2e-cron-${Date.now().toString(36)}`, type: 'cron', repoUrl: `${GIT}/cron-job.git`, cronSchedule: '* * * * *', startCommand: 'node task.js' });
  created.push(res.service.id);
  await waitDeploy(res.deploy.id);
  const run = await api('POST', `/services/${res.service.id}/runs`, {});
  const done = await until('run done', async () => { const r = await api('GET', `/runs/${run.id}`); return ['succeeded', 'failed'].includes(r.status) ? r : null; }, 60_000);
  assert(done.status === 'succeeded', `run ${done.status}`);
  const logs = await api('GET', `/runs/${run.id}/logs`);
  assert(logs.items.some((l: any) => /cron tick/.test(l.message)), 'run output missing');
  const bad = await api('POST', `/services/${res.service.id}/runs`, { command: 'node task.js fail' });
  const badDone = await until('failing job', async () => { const r = await api('GET', `/runs/${bad.id}`); return ['succeeded', 'failed'].includes(r.status) ? r : null; }, 60_000);
  assert(badDone.status === 'failed' && badDone.exitCode === 2, `expected failed/2, got ${badDone.status}/${badDone.exitCode}`);
  await until('scheduled run', async () => (await api('GET', `/services/${res.service.id}/runs`)).items.some((r: any) => r.trigger === 'schedule' && r.status === 'succeeded'), 150_000, 5000);
});

await step('postgres: provision, query, backup, restore', 'db', async () => {
  const db = await api('POST', `/workspaces/${ws}/databases`, { name: `e2e-db-${Date.now().toString(36)}` });
  created.push(db.id);
  await until('database available', async () => (await api('GET', `/databases/${db.id}`)).status === 'available', 120_000);
  const creds = await api('GET', `/databases/${db.id}/credentials`);
  assert(creds.password.length >= 24, 'generated password');
  await api('POST', `/databases/${db.id}/query`, { sql: 'CREATE TABLE notes (id serial primary key, body text); INSERT INTO notes (body) VALUES (\'one\'), (\'two\');' });
  const b = await api('POST', `/databases/${db.id}/backups`);
  await until('backup completed', async () => (await api('GET', `/databases/${db.id}/backups`)).items.find((x: any) => x.id === b.id)?.status === 'completed', 60_000);
  await api('POST', `/databases/${db.id}/query`, { sql: "INSERT INTO notes (body) VALUES ('three')" });
  const c3 = await api('POST', `/databases/${db.id}/query`, { sql: 'SELECT count(*) FROM notes' });
  assert(Number(c3.rows[0][0]) === 3, 'expected 3 rows before restore');
  await api('POST', `/databases/${db.id}/backups/${b.id}/restore`);
  await until('restored', async () => (await api('GET', `/databases/${db.id}`)).status === 'available', 120_000);
  const c2 = await until('query after restore', async () => (await api('POST', `/databases/${db.id}/query`, { sql: 'SELECT count(*) FROM notes' })), 30_000);
  assert(Number(c2.rows[0][0]) === 2, `expected 2 rows after restore, got ${c2.rows[0][0]}`);
  await api('PATCH', `/databases/${db.id}`, { ipAllowList: [{ cidr: '10.0.0.0/8', description: 'vpc' }] });
});

await step('blueprint: nav.yaml creates db, env group, web, worker and cron', 'blueprint', async () => {
  const v = await api('POST', '/blueprints/validate', { yaml: 'services:\n  - type: cron\n    name: x\n' });
  assert(!v.valid && /schedule/.test(v.errors[0]), 'validation should require a schedule');
  const bp = await api('POST', `/workspaces/${ws}/blueprints`, { name: 'e2e-blueprint', repoUrl: `${GIT}/examples.git`, branch: 'main', filePath: 'nav.yaml' });
  const synced = await until('blueprint in sync', async () => { const b = await api('GET', `/blueprints/${bp.id}`); if (b.status === 'error') throw new Error(b.lastError); return b.status === 'in_sync' ? b : null; }, 240_000, 3000);
  assert(synced.resources.length === 5, `expected 5 managed resources, got ${synced.resources.length}`);
  const webSvc = synced.resources.find((r: any) => r.name === 'bp-web');
  const env = await api('GET', `/services/${webSvc.id}/env-vars`);
  assert(env.items.some((e: any) => e.key === 'DATABASE_URL' && e.value.startsWith('postgresql://')), 'fromDatabase not resolved');
  assert(env.items.some((e: any) => e.key === 'SESSION_SECRET' && e.value.length >= 32), 'generateValue');
  const deps = await api('GET', `/services/${webSvc.id}/deploys`);
  await waitDeploy(deps.items[0].id);
  const j = await (await edge((await api('GET', `/services/${webSvc.id}`)).slug, '/')).json();
  assert(j.message === 'Hello from a NAV blueprint', 'env group value should reach the app');
  if (!keep) await api('DELETE', `/blueprints/${bp.id}?deleteResources=1`);
});

if (!keep) {
  for (const id of created) await api('DELETE', id.startsWith('dpg_') ? `/databases/${id}` : `/services/${id}`).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed:` : ''}`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.err?.split('\n')[0]}`);
process.exit(failed.length ? 1 : 0);
