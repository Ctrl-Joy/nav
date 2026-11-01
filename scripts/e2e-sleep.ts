// End-to-end check of free-instance sleep: a free web service with no traffic goes to sleep (instances stopped),
// and the next request wakes it and is answered. Run against a stack started with NAV_FREE_SLEEP_MINUTES=1.
// Usage: node scripts/e2e-sleep.ts
import http from 'node:http';

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const EDGE = process.env.NAV_EDGE ?? 'http://127.0.0.1:7080';
const GIT = process.env.NAV_GIT ?? 'http://localhost:9420';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let token = '';
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
function edge(slug: string, p = '/healthz'): Promise<{ status: number; headers: http.IncomingHttpHeaders; ms: number }> {
  const t = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(EDGE + p);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: `${slug}.nav.localhost` } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, ms: Date.now() - t }));
    });
    req.on('error', reject);
    req.setTimeout(90_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const r = await fetch(`${API}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ email: `sleep-${Date.now()}@nav.test`, password: 'correct-horse-battery' }) });
const cookie = r.headers.get('set-cookie')!.split(';')[0];
const ws = (await r.json()).workspaces[0].id;
token = (await fetch(`${API}/api-keys`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ name: 'sleep' }) }).then((x) => x.json())).token;

const created = await api('POST', `/workspaces/${ws}/services`, { name: `sleepy-${Date.now().toString(36)}`, type: 'web', repoUrl: `${GIT}/node-web.git`, healthCheckPath: '/healthz', plan: 'free' });
const svc = created.service;
let ok = true;
try {
  for (let i = 0; i < 90 && (await api('GET', `/deploys/${created.deploy.id}`)).status !== 'live'; i++) await sleep(2000);
  assert((await edge(svc.slug)).status === 200, 'serves while awake');
  console.log('  • live on the free plan; now idle and waiting for it to sleep (up to ~3 min)...');
  let s: any;
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) { s = await api('GET', `/services/${svc.id}`); if (s.sleeping) break; await sleep(3000); }
  assert(s.sleeping, 'service should be marked sleeping after the idle period');
  const inst = (await api('GET', `/services/${svc.id}/instances`)).items.filter((i: any) => ['healthy', 'starting', 'pending'].includes(i.status));
  console.log(`  • asleep after ${Math.round((Date.now() - t0) / 1000)}s of watching; running instances: ${inst.length}`);
  assert(inst.length === 0, 'instances are stopped while asleep');
  await sleep(1500);
  const woke = await edge(svc.slug);
  console.log(`  • first request: ${woke.status} after ${(woke.ms / 1000).toFixed(1)}s, x-nav-woke=${woke.headers['x-nav-woke']}`);
  assert(woke.status === 200 && woke.headers['x-nav-woke'] === '1', 'the first request wakes the service and is answered');
  const next = await edge(svc.slug);
  assert(next.status === 200 && !next.headers['x-nav-woke'] && next.ms < 2000, 'later requests are served normally');
  const after = await api('GET', `/services/${svc.id}`);
  assert(!after.sleeping, 'not sleeping after wake');
  const events = (await api('GET', `/services/${svc.id}/events`)).items.map((e: any) => e.kind);
  assert(events.includes('service_slept') && events.includes('service_woke'), `events recorded: ${events.slice(0, 6).join(', ')}`);
  // Paid plans never sleep.
  await api('PATCH', `/services/${svc.id}`, { plan: 'starter' });
  console.log('  • slept, woke on request, events recorded; switched to a paid plan');
} catch (err) {
  ok = false;
  console.log(`  ✗ ${(err as Error).message}`);
} finally {
  await api('DELETE', `/services/${svc.id}`).catch(() => {});
}
console.log(ok ? '\nsleep/wake: passed' : '\nsleep/wake: FAILED');
process.exit(ok ? 0 : 1);
