import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { Edge } from '../src/proxy.ts';
import { RouteTable, type EdgeRouteRow } from '../src/routes.ts';
import { Metrics } from '../src/metrics.ts';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function request(port: number, host: string, p: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host, ...opts.headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(payload));
    let out = '';
    s.on('data', (d) => { out += d.toString(); });
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
    s.setTimeout(3000, () => { s.destroy(); resolve(out); });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
}

function upstream(name: string): http.Server {
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.setHeader('connection', 'keep-alive');
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': name });
      res.end(JSON.stringify({ name, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
  });
  s.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\nX-Upstream: ' + name + '\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from(`${name}:`), d])));
    socket.on('error', () => {});
  });
  return s;
}

let upA: http.Server, upB: http.Server, edgeServer: http.Server;
let portA = 0, portB = 0, deadPort = 0, deadPort2 = 0, edgePort = 0;
let edge: Edge;
let table: RouteTable;
const metrics = new Metrics(null);
const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-edge-site-'));
const bigJs = `console.log(${JSON.stringify('x'.repeat(5000))});\n`;

const row = (o: Partial<EdgeRouteRow> & { service_id: string; slug: string }): EdgeRouteRow => ({
  type: 'web', suspended: false, maintenance_mode: false, status: 'live', static_headers: [], static_routes: [],
  artifact: null, upstreams: [], domains: [], ...o,
});

before(async () => {
  upA = upstream('A');
  upB = upstream('B');
  portA = await listen(upA);
  portB = await listen(upB);
  const tmp = http.createServer();
  deadPort = await listen(tmp);
  await new Promise<void>((r) => tmp.close(() => r()));
  const tmp2 = http.createServer();
  deadPort2 = await listen(tmp2);
  await new Promise<void>((r) => tmp2.close(() => r()));

  fs.writeFileSync(path.join(siteRoot, 'index.html'), '<!doctype html><h1>home</h1>');
  fs.writeFileSync(path.join(siteRoot, 'app.js'), bigJs);
  fs.writeFileSync(path.join(siteRoot, 'main.abc123.js'), 'hashed();');
  fs.writeFileSync(path.join(siteRoot, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(siteRoot, 'bytes.txt'), '0123456789');
  fs.mkdirSync(path.join(siteRoot, 'docs'));
  fs.writeFileSync(path.join(siteRoot, 'docs', 'index.html'), 'docs index');
  fs.writeFileSync(path.join(os.tmpdir(), 'nav-edge-secret.txt'), 'top secret');

  table = new RouteTable('nav.test');
  table.setRows([
    row({ service_id: 'svc-rr', slug: 'rr', upstreams: [{ id: 'inst-a', host: '127.0.0.1', port: portA }, { id: 'inst-b', host: '127.0.0.1', port: portB }] }),
    row({ service_id: 'svc-dead', slug: 'dead', upstreams: [{ id: 'inst-dead', host: '127.0.0.1', port: deadPort }, { id: 'inst-a', host: '127.0.0.1', port: portA }] }),
    row({ service_id: 'svc-onlydead', slug: 'onlydead', upstreams: [{ id: 'inst-dead2', host: '127.0.0.1', port: deadPort2 }] }),
    row({ service_id: 'svc-empty', slug: 'empty', upstreams: [], domains: [{ domain: 'www.example.com', redirectTo: 'example.com' }, { domain: 'example.com', redirectTo: null }] }),
    row({ service_id: 'svc-susp', slug: 'susp', suspended: true, upstreams: [{ id: 'x', host: '127.0.0.1', port: portA }] }),
    row({ service_id: 'svc-maint', slug: 'maint', maintenance_mode: true, upstreams: [{ id: 'x', host: '127.0.0.1', port: portA }] }),
    row({
      service_id: 'svc-site', slug: 'site', type: 'static', artifact: { kind: 'dir', path: siteRoot },
      static_routes: [
        { type: 'redirect', source: '/old/*', destination: '/new/:splat' },
        { type: 'rewrite', source: '/api/*', destination: `http://127.0.0.1:${portA}/v1/:splat` },
        { type: 'rewrite', source: '/*', destination: '/index.html' },
      ],
      static_headers: [{ path: '/*', name: 'X-Frame-Options', value: 'DENY' }, { path: '/docs/*', name: 'X-Docs', value: 'yes' }],
    }),
  ]);
  edge = new Edge({ table, metrics, acmeLookup: async (t) => (t === 'tok123' ? 'tok123.thumb' : null), log: () => {}, ejectMs: 10_000 });
  edgeServer = http.createServer();
  edge.attach(edgeServer, false);
  edgePort = await listen(edgeServer);
});

after(async () => {
  edge.closeAll();
  edgeServer.closeAllConnections();
  upA.closeAllConnections();
  upB.closeAllConnections();
  await Promise.all([edgeServer, upA, upB].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

test('round-robin across upstreams, headers forwarded and echoed', async () => {
  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await request(edgePort, 'rr.nav.test:8080', `/hello?i=${i}`, { headers: { 'x-forwarded-for': '1.2.3.4, not-an-ip', 'x-forwarded-proto': 'https', 'x-request-id': 'client-supplied-id-1' } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body.toString());
    names.push(j.name);
    assert.equal(j.url, `/hello?i=${i}`);
    assert.equal(j.headers['x-forwarded-for'], '1.2.3.4, 127.0.0.1');
    assert.equal(j.headers['x-forwarded-proto'], 'http');
    assert.equal(j.headers['x-forwarded-host'], 'rr.nav.test:8080');
    assert.equal(j.headers['x-forwarded-port'], String(edgePort));
    assert.equal(j.headers.host, 'rr.nav.test:8080');
    assert.equal(j.headers['x-request-id'], 'client-supplied-id-1');
    assert.equal(r.headers['x-request-id'], 'client-supplied-id-1');
    assert.equal(r.headers['nav-routing'], j.name === 'A' ? 'inst-a' : 'inst-b');
    assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
    assert.equal(r.headers['x-upstream'], j.name);
  }
  assert.deepEqual(names.slice().sort(), ['A', 'A', 'B', 'B']);
  assert.notEqual(names[0], names[1]);
  assert.notEqual(names[1], names[2]);
});

test('generates a request id when absent and streams POST bodies', async () => {
  const r = await request(edgePort, 'rr.nav.test', '/post', { method: 'POST', body: 'payload=1', headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body.toString());
  assert.equal(j.body, 'payload=1');
  assert.match(String(r.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  assert.equal(j.headers['x-request-id'], r.headers['x-request-id']);
});

test('connection error ejects the upstream and retries idempotent requests', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await request(edgePort, 'dead.nav.test', '/');
    assert.equal(r.status, 200, `request ${i}`);
    assert.equal(JSON.parse(r.body.toString()).name, 'A');
  }
  assert.equal(edge.balancer.isHealthy({ id: 'inst-dead', host: '127.0.0.1', port: deadPort }), false);
});

test('POST to an unreachable upstream is not retried (502)', async () => {
  const r = await request(edgePort, 'onlydead.nav.test', '/', { method: 'POST', body: 'x' });
  assert.equal(r.status, 502);
  // and now the only upstream is ejected -> 503 starting page
  const r2 = await request(edgePort, 'onlydead.nav.test', '/');
  assert.equal(r2.status, 503);
});

test('503 when no healthy upstreams (HTML and JSON)', async () => {
  const html = await request(edgePort, 'empty.nav.test', '/');
  assert.equal(html.status, 503);
  assert.match(String(html.headers['content-type']), /text\/html/);
  assert.match(html.body.toString(), /Service is starting/);
  const json = await request(edgePort, 'empty.nav.test', '/', { headers: { accept: 'application/json' } });
  assert.equal(json.status, 503);
  assert.equal(JSON.parse(json.body.toString()).error.code, 'no_healthy_instances');
});

test('service states, unknown hosts, redirects, health, ACME', async () => {
  assert.match((await request(edgePort, 'susp.nav.test', '/')).body.toString(), /suspended/);
  assert.equal((await request(edgePort, 'susp.nav.test', '/')).status, 503);
  const m = await request(edgePort, 'maint.nav.test', '/');
  assert.equal(m.status, 503);
  assert.match(m.body.toString(), /maintenance/);
  const nf = await request(edgePort, 'nobody.nav.test', '/');
  assert.equal(nf.status, 404);
  assert.match(nf.body.toString(), /No NAV service at this address/);
  const red = await request(edgePort, 'www.example.com:8080', '/a/b?c=1');
  assert.equal(red.status, 301);
  assert.equal(red.headers.location, 'http://example.com:8080/a/b?c=1');
  const h = await request(edgePort, 'anything', '/__nav/health');
  assert.deepEqual(JSON.parse(h.body.toString()), { ok: true, routes: table.size });
  // ACME must work on redirecting domains and unknown hosts
  const a = await request(edgePort, 'www.example.com', '/.well-known/acme-challenge/tok123');
  assert.equal(a.status, 200);
  assert.equal(a.body.toString(), 'tok123.thumb');
  assert.equal((await request(edgePort, 'unknown.org', '/.well-known/acme-challenge/nope')).status, 404);
  assert.equal((await request(edgePort, 'bad host!', '/')).status, 400);
});

test('request smuggling and oversize protections', async () => {
  const both = await rawRequest(edgePort, 'POST / HTTP/1.1\r\nHost: rr.nav.test\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n');
  assert.match(both, /^HTTP\/1\.1 400/);
  const longUrl = await request(edgePort, 'rr.nav.test', `/${'a'.repeat(9000)}`);
  assert.equal(longUrl.status, 414);
  const bigHeaders = await rawRequest(edgePort, `GET / HTTP/1.1\r\nHost: rr.nav.test\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`);
  assert.match(bigHeaders, /^HTTP\/1\.1 431/);
});

test('WebSocket upgrade is piped both ways', async () => {
  const result = await new Promise<{ status: number; upstreamHeader: string; echo: string; routing: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: edgePort, path: '/ws', agent: false, headers: { host: 'rr.nav.test', connection: 'Upgrade', upgrade: 'echo' } });
    req.on('upgrade', (res, socket) => {
      socket.write('ping');
      socket.once('data', (d) => {
        resolve({ status: res.statusCode!, upstreamHeader: String(res.headers['x-upstream']), echo: d.toString(), routing: String(res.headers['nav-routing']) });
        socket.destroy();
      });
    });
    req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
  assert.equal(result.status, 101);
  assert.equal(result.echo, `${result.upstreamHeader}:ping`);
  assert.equal(result.routing, result.upstreamHeader === 'A' ? 'inst-a' : 'inst-b');
});

test('WebSocket upgrade to a host with no upstreams gets 503', async () => {
  const out = await rawRequest(edgePort, 'GET / HTTP/1.1\r\nHost: empty.nav.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  assert.match(out, /^HTTP\/1\.1 503/);
});

test('static: index, ETag/304, cache-control, gzip, brotli, HEAD, range, headers', async () => {
  const idx = await request(edgePort, 'site.nav.test', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.body.toString(), /home/);
  assert.equal(idx.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.match(String(idx.headers['content-type']), /^text\/html; charset=utf-8/);
  assert.equal(idx.headers['x-frame-options'], 'DENY');

  const js = await request(edgePort, 'site.nav.test', '/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.body.toString(), bigJs);
  const etag = String(js.headers.etag);
  assert.ok(etag);
  const nm = await request(edgePort, 'site.nav.test', '/app.js', { headers: { 'if-none-match': etag } });
  assert.equal(nm.status, 304);
  assert.equal(nm.body.length, 0);

  for (let i = 0; i < 2; i++) { // second request exercises the compressed LRU
    const gz = await request(edgePort, 'site.nav.test', '/app.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.ok(gz.body.length < bigJs.length);
    assert.equal(zlib.gunzipSync(gz.body).toString(), bigJs);
    const gzTag = String(gz.headers.etag);
    assert.notEqual(gzTag, etag);
    assert.equal((await request(edgePort, 'site.nav.test', '/app.js', { headers: { 'accept-encoding': 'gzip', 'if-none-match': gzTag } })).status, 304);
  }
  const br = await request(edgePort, 'site.nav.test', '/app.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), bigJs);

  const hashed = await request(edgePort, 'site.nav.test', '/main.abc123.js');
  assert.equal(hashed.headers['cache-control'], 'public, max-age=31536000, immutable');

  const head = await request(edgePort, 'site.nav.test', '/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(bigJs)));

  const range = await request(edgePort, 'site.nav.test', '/bytes.txt', { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.body.toString(), '2345');
  assert.equal(range.headers['content-range'], 'bytes 2-5/10');
  const suffix = await request(edgePort, 'site.nav.test', '/bytes.txt', { headers: { range: 'bytes=-3' } });
  assert.equal(suffix.body.toString(), '789');
  assert.equal((await request(edgePort, 'site.nav.test', '/bytes.txt', { headers: { range: 'bytes=50-60' } })).status, 416);

  const docs = await request(edgePort, 'site.nav.test', '/docs/');
  assert.equal(docs.body.toString(), 'docs index');
  assert.equal(docs.headers['x-docs'], 'yes');
  const docsNoSlash = await request(edgePort, 'site.nav.test', '/docs');
  assert.equal(docsNoSlash.status, 301);
  assert.equal(docsNoSlash.headers.location, '/docs/');

  const post = await request(edgePort, 'site.nav.test', '/app.js', { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
});

test('static: redirects, SPA rewrite, external rewrite proxy, dotfiles and traversal', async () => {
  const red = await request(edgePort, 'site.nav.test', '/old/a/b?q=1');
  assert.equal(red.status, 301);
  assert.equal(red.headers.location, '/new/a/b?q=1');

  const spa = await request(edgePort, 'site.nav.test', '/dashboard/settings');
  assert.equal(spa.status, 200);
  assert.match(spa.body.toString(), /home/);
  // real files still win over the catch-all rewrite
  assert.equal((await request(edgePort, 'site.nav.test', '/bytes.txt')).body.toString(), '0123456789');

  const api = await request(edgePort, 'site.nav.test', '/api/users?x=1');
  assert.equal(api.status, 200);
  const j = JSON.parse(api.body.toString());
  assert.equal(j.name, 'A');
  assert.equal(j.url, '/v1/users?x=1');

  for (const p of ['/.env', '/%2e%2e/nav-edge-secret.txt', '/..%2fnav-edge-secret.txt', '/..%5cnav-edge-secret.txt', '/a%00b']) {
    const r = await request(edgePort, 'site.nav.test', p);
    assert.ok(r.status !== 200 || !/SECRET|top secret/.test(r.body.toString()), `leak via ${p}`);
    assert.doesNotMatch(r.body.toString(), /SECRET=1|top secret/);
  }
});

test('static: custom 404.html when no catch-all rewrite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-edge-404-'));
  fs.writeFileSync(path.join(root, '404.html'), 'custom not found');
  const before = table.all().slice();
  table.setRoutes([...before, { ...before.find((r) => r.slug === 'site')!, serviceId: 'svc-404', slug: 'nf', staticRoutes: [], artifact: { kind: 'dir', path: root }, domains: [] }]);
  const r = await request(edgePort, 'nf.nav.test', '/missing');
  assert.equal(r.status, 404);
  assert.equal(r.body.toString(), 'custom not found');
  table.setRoutes(before);
});

test('metrics recorded per service', () => {
  const snap = metrics.snapshot();
  const rr = snap.filter((b) => b.serviceId === 'svc-rr').reduce((n, b) => n + b.requests, 0);
  assert.ok(rr >= 5, `expected rr requests, got ${rr}`);
  assert.ok(snap.some((b) => b.serviceId === 'svc-empty' && b.s5xx > 0));
  assert.ok(snap.some((b) => b.serviceId === 'svc-site' && b.bytesOut > 0));
});
