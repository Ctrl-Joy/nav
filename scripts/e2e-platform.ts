// End-to-end checks for the platform features: inbound IP rules, edge caching, graceful shutdown delay, private
// registry credentials, Key Value, log streams (syslog + HTTPS), OpenTelemetry metrics, disk snapshots and the
// MCP server. Usage: node scripts/e2e-platform.ts   (against npm run dev + scripts/git-serve.ts)
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const EDGE = process.env.NAV_EDGE ?? 'http://127.0.0.1:7080';
const GIT = process.env.NAV_GIT ?? 'http://localhost:9420';
const results: { name: string; ok: boolean }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let token = '';
let ws = '';
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  const data = t ? JSON.parse(t) : null;
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${data?.error?.message ?? t}`);
  return data;
}
function edge(slug: string, p = '/'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(EDGE + p);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host: `${slug}.nav.localhost` } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(1000); }
  throw new Error(`timed out waiting for ${what}`);
}
async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  • ${name} ... `);
  try { await fn(); results.push({ name, ok: true }); console.log('\x1b[32mok\x1b[0m'); }
  catch (err) { results.push({ name, ok: false }); console.log(`\x1b[31mFAILED\x1b[0m\n    ${(err as Error).message}`); }
}

console.log(`NAV platform e2e against ${API}\n`);
{
  const email = `platform-${Date.now()}@nav.test`;
  const res = await fetch(`${API}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  ws = (await res.json()).workspaces[0].id;
  token = (await fetch(`${API}/api-keys`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-nav-csrf': '1' }, body: JSON.stringify({ name: 'e2e' }) }).then((r) => r.json())).token;
}

// One web service with a disk, used by most steps.
const created = await api('POST', `/workspaces/${ws}/services`, {
  name: `plat-${Date.now().toString(36)}`, type: 'web', repoUrl: `${GIT}/node-web.git`, healthCheckPath: '/healthz', plan: 'starter',
  disk: { name: 'data', mountPath: '/data', sizeGB: 1 },
});
const svc = created.service;
await until('first deploy live', async () => (await api('GET', `/deploys/${created.deploy.id}`)).status === 'live', 180_000);

await step('inbound IP rules: other networks get 403, allowed networks pass', async () => {
  await api('PATCH', `/services/${svc.id}`, { ipAllowList: [{ cidr: '203.0.113.0/24', description: 'office' }] });
  const blocked = await until('rule applied', async () => { const r = await edge(svc.slug, '/healthz'); return r.status === 403 ? r : null; }, 15_000);
  assert(blocked.body.includes('ip_not_allowed') || blocked.status === 403, 'blocked page');
  await api('PATCH', `/services/${svc.id}`, { ipAllowList: [{ cidr: '127.0.0.0/8', description: 'local' }, { cidr: '::1/128', description: 'local v6' }] });
  await until('allowed again', async () => (await edge(svc.slug, '/healthz')).status === 200, 15_000);
  await api('PATCH', `/services/${svc.id}`, { ipAllowList: [] });
});

await step('edge caching: public responses are served from the edge until purged', async () => {
  await api('PATCH', `/services/${svc.id}`, { edgeCache: { enabled: true, maxTtlSeconds: 300 } });
  await sleep(1500);
  const first = await edge(svc.slug, '/cached');
  assert(first.headers['x-nav-cache'] === 'MISS', `first request should miss, got ${first.headers['x-nav-cache']}`);
  const second = await edge(svc.slug, '/cached');
  assert(second.headers['x-nav-cache'] === 'HIT' && second.body === first.body, `second should be a hit with the same body (${second.headers['x-nav-cache']})`);
  const dynamic = await edge(svc.slug, '/');
  assert(dynamic.headers['x-nav-cache'] === 'BYPASS', 'responses without public caching headers are not stored');
  await api('POST', `/services/${svc.id}/cache/purge`);
  await sleep(1500);
  const after = await edge(svc.slug, '/cached');
  assert(after.headers['x-nav-cache'] === 'MISS' && after.body !== first.body, 'purge empties the cache');
  await api('PATCH', `/services/${svc.id}`, { edgeCache: { enabled: false } });
});

await step('graceful shutdown delay is configurable (1–300 s)', async () => {
  const s = await api('PATCH', `/services/${svc.id}`, { shutdownDelaySeconds: 5 });
  assert(s.shutdownDelaySeconds === 5, 'saved');
  const bad = await fetch(`${API}/services/${svc.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ shutdownDelaySeconds: 900 }) });
  assert(bad.status === 400, 'out-of-range delay refused');
});

await step('registry credentials: stored encrypted, never returned, attachable to a service', async () => {
  const c = await api('POST', `/workspaces/${ws}/registry-credentials`, { name: 'ghcr', registry: 'ghcr.io', username: 'bot', password: 'ghp_supersecret' });
  const list = await api('GET', `/workspaces/${ws}/registry-credentials`);
  assert(list.items.length === 1 && !JSON.stringify(list).includes('supersecret'), 'password is never returned');
  const s = await api('PATCH', `/services/${svc.id}`, { registryCredentialId: c.id });
  assert(s.registryCredentialId === c.id, 'attached');
  await api('DELETE', `/registry-credentials/${c.id}`);
  assert((await api('GET', `/services/${svc.id}`)).registryCredentialId === null, 'detached on delete');
});

await step('Key Value: create, credentials, settings; refuses cleanly without a server binary/Docker', async () => {
  const kv = await api('POST', `/workspaces/${ws}/key-value`, { name: 'cache', plan: 'starter', maxmemoryPolicy: 'allkeys-lfu' });
  assert(kv.slug && kv.status === 'creating', 'created');
  const done = await until('provisioning finished', async () => { const k = await api('GET', `/key-value/${kv.id}`); return k.status !== 'creating' ? k : null; }, 60_000);
  if (done.status === 'available') {
    const cred = await api('GET', `/key-value/${kv.id}/credentials`);
    assert(cred.internalUrl.startsWith('redis://default:'), 'connection string');
    // Speak RESP: AUTH, PING, then a write and a read back.
    const u = new URL(cred.internalUrl.replace(/@[^:]+:/, '@127.0.0.1:'));
    const talk = (cmds: string, until: string) => new Promise<string>((resolve, reject) => {
      const s = net.connect(Number(u.port), '127.0.0.1', () => s.write(cmds));
      let b = '';
      const t = setTimeout(() => { s.destroy(); resolve(b); }, 5000);
      s.on('data', (d) => { b += d; if (b.includes(until)) { clearTimeout(t); s.end(); resolve(b); } });
      s.on('error', reject);
    });
    const reply = await talk(`AUTH ${cred.password}\r\nPING\r\nSET nav:e2e works\r\nGET nav:e2e\r\n`, 'works');
    assert(reply.includes('+OK') && reply.includes('PONG') && reply.includes('$5\r\nworks'), `server replied ${JSON.stringify(reply)}`);
    const unauth = await talk('GET nav:e2e\r\n', '\r\n');
    assert(/NOAUTH|-ERR|-WRONGPASS/.test(unauth), `a client without the password must be refused: ${JSON.stringify(unauth)}`);
  } else {
    const logs = await api('GET', `/key-value/${kv.id}/logs`);
    assert(done.status === 'failed' && logs.items.some((l: any) => /docker driver|valkey-server/.test(l.message)), 'clear failure when no server is available');
  }
  const p = await api('PATCH', `/key-value/${kv.id}`, { maxmemoryPolicy: 'noeviction' });
  assert(p.maxmemoryPolicy === 'noeviction', 'policy updated');
  await api('DELETE', `/key-value/${kv.id}`);
});

await step('log streams: RFC 5424 syslog over TCP with token, and NDJSON over HTTPS', async () => {
  const lines: string[] = [];
  const syslog = net.createServer((s) => s.on('data', (d) => lines.push(String(d))));
  await new Promise<void>((r) => syslog.listen(0, '127.0.0.1', () => r()));
  const posts: string[] = [];
  const httpSink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { posts.push(`${req.headers.authorization}\n${b}`); res.end(); }); });
  await new Promise<void>((r) => httpSink.listen(0, '127.0.0.1', () => r()));
  try {
    await api('PUT', `/workspaces/${ws}/log-stream`, { protocol: 'syslog-tcp', endpoint: `127.0.0.1:${(syslog.address() as net.AddressInfo).port}`, token: 'tok-123' });
    await sleep(1500);
    await api('POST', `/services/${svc.id}/restart`);
    const got = await until('syslog lines', async () => (lines.join('').includes(svc.slug) ? lines.join('') : null), 60_000);
    assert(/<\d+>1 \d{4}-\d\d-\d\dT/.test(got) && got.includes('token="tok-123"'), `RFC 5424 with token: ${got.slice(0, 200)}`);
    await api('PUT', `/services/${svc.id}/log-stream`, { protocol: 'https', endpoint: `http://127.0.0.1:${(httpSink.address() as net.AddressInfo).port}/ingest`, token: 'bearer-xyz' });
    await sleep(1500);
    await edge(svc.slug, '/crash').catch(() => {});
    const post = await until('https batch', async () => posts.find((p) => p.startsWith('Bearer bearer-xyz')), 60_000);
    assert(post.split('\n').slice(1).every((l) => !l || JSON.parse(l).message !== undefined), 'NDJSON body');
    const list = await api('GET', `/workspaces/${ws}/log-streams`);
    assert(list.default && list.overrides.length === 1 && !JSON.stringify(list).includes('tok-123'), 'tokens are never returned');
  } finally {
    await api('DELETE', `/services/${svc.id}/log-stream`).catch(() => {});
    await api('DELETE', `/workspaces/${ws}/log-stream`).catch(() => {});
    syslog.close();
    httpSink.close();
  }
});

await step('OpenTelemetry metrics: OTLP/HTTP JSON with service attributes', async () => {
  const bodies: { headers: http.IncomingHttpHeaders; body: any }[] = [];
  const otlp = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { bodies.push({ headers: req.headers, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise<void>((r) => otlp.listen(0, '127.0.0.1', () => r()));
  try {
    await api('PUT', `/workspaces/${ws}/metrics-stream`, { endpoint: `http://127.0.0.1:${(otlp.address() as net.AddressInfo).port}`, headers: { 'x-api-key': 'k1' } });
    const r = await until('a push with data', async () => { const t = await api('POST', `/workspaces/${ws}/metrics-stream/test`); return bodies.length ? t : null; }, 60_000);
    assert(!r.stream.lastError, `no error: ${r.stream.lastError}`);
    const b = bodies[0];
    assert(b.headers['x-api-key'] === 'k1', 'custom headers sent');
    const rm = b.body.resourceMetrics.find((x: any) => x.resource.attributes.some((a: any) => a.key === 'nav.service.id' && a.value.stringValue === svc.id));
    assert(rm && rm.scopeMetrics[0].metrics.some((m: any) => m.name === 'nav.instance.memory.usage'), 'memory gauge for the service');
  } finally {
    await api('DELETE', `/workspaces/${ws}/metrics-stream`).catch(() => {});
    otlp.close();
  }
});

await step('disk snapshots: snapshot, change the disk, restore the old contents', async () => {
  await until('live', async () => (await edge(svc.slug, '/healthz')).status === 200, 60_000);
  assert((await edge(svc.slug, '/disk?write=v1')).body === 'v1', 'write v1 to the disk');
  const snap = await api('POST', `/services/${svc.id}/disk/snapshots`);
  await until('snapshot completed', async () => (await api('GET', `/services/${svc.id}/disk/snapshots`)).items.find((s: any) => s.id === snap.id && s.status === 'completed'), 60_000);
  assert((await edge(svc.slug, '/disk?write=v2')).body === 'v2', 'overwrite with v2');
  await api('POST', `/disk-snapshots/${snap.id}/restore`);
  const back = await until('restored and live', async () => { const r = await edge(svc.slug, '/disk'); return r.status === 200 && r.body === 'v1' ? r : null; }, 120_000);
  assert(back.body === 'v1', 'disk contents restored');
});

await step('MCP server: initialize, list tools, call list_services over stdio', async () => {
  const cli = spawn(process.execPath, [path.resolve('apps/cli/src/main.ts'), 'mcp'], { env: { ...process.env, NAV_HOST: API.replace(/\/api\/v1$/, ''), NAV_TOKEN: token, NAV_WORKSPACE: ws }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map<number, any>();
  let buf = '';
  cli.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); } });
  const call = async (id: number, method: string, params: unknown = {}) => {
    cli.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return until(`reply ${id}`, async () => replies.get(id), 15_000);
  };
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    assert(init.result.serverInfo.name === 'nav', 'initialize');
    cli.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await call(2, 'tools/list');
    assert(tools.result.tools.some((t: any) => t.name === 'trigger_deploy'), 'tools listed');
    const res = await call(3, 'tools/call', { name: 'list_services', arguments: { workspaceId: ws } });
    assert(!res.result.isError && res.result.content[0].text.includes(svc.id), `list_services: ${JSON.stringify(res).slice(0, 300)}`);
  } finally {
    cli.kill();
  }
});

await api('DELETE', `/services/${svc.id}`).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`);
process.exit(failed.length ? 1 : 0);
