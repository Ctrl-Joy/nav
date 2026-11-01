import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Edge } from '../src/proxy.ts';
import { RouteTable } from '../src/routes.ts';

// The dashboard host (NAV_DASHBOARD_HOST) is proxied to the control plane: dashboard SPA, API and the shell
// WebSocket, never the node-only /internal API.

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, host: string, p: string, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host, accept: 'application/json' }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
}

let control: http.Server, app: http.Server, edgeServer: http.Server;
let edge: Edge;
let edgePort = 0;
let controlPort = 0;
let hasCert = false;

before(async () => {
  control = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ who: 'control', url: req.url, host: req.headers.host, proto: req.headers['x-forwarded-proto'], xff: req.headers['x-forwarded-for'] }));
  });
  control.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('control:'), d])));
    socket.on('error', () => {});
  });
  app = http.createServer((req, res) => { res.end('app'); });
  controlPort = await listen(control);
  const appPort = await listen(app);

  const table = new RouteTable('nav.test');
  table.setRows([
    // A service whose slug collides with the dashboard label must not shadow the control plane.
    { service_id: 'svc-d', slug: 'dashboard', type: 'web', suspended: false, maintenance_mode: false, upstreams: [{ id: 'i', host: '127.0.0.1', port: appPort }], domains: [] },
    { service_id: 'svc-a', slug: 'shop', type: 'web', suspended: false, maintenance_mode: false, upstreams: [{ id: 'i', host: '127.0.0.1', port: appPort }], domains: [] },
  ]);
  edge = new Edge({
    table, log: () => {}, production: true, forceHttps: true, httpsPort: 443, hasCert: () => hasCert,
    controlPlane: { host: 'dashboard.nav.test', target: { host: '127.0.0.1', port: controlPort }, apexRedirect: 'nav.test' },
  });
  edgeServer = http.createServer();
  edge.attach(edgeServer, false);
  edgePort = await listen(edgeServer);
});

after(async () => {
  edge.closeAll();
  for (const s of [edgeServer, control, app]) s.closeAllConnections();
  await Promise.all([edgeServer, control, app].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

test('dashboard host is proxied to the control plane with forwarding headers; services still route', async () => {
  const r = await request(edgePort, 'dashboard.nav.test', '/api/v1/auth/me?x=1');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.who, 'control');
  assert.equal(body.url, '/api/v1/auth/me?x=1');
  assert.equal(body.host, 'dashboard.nav.test');
  assert.equal(body.proto, 'http');
  assert.equal(body.xff, '127.0.0.1');
  assert.equal(r.headers['nav-routing'], undefined);

  const spa = await request(edgePort, 'DASHBOARD.nav.test:80', '/w/abc/services');
  assert.equal(JSON.parse(spa.body).who, 'control');
  assert.equal((await request(edgePort, 'shop.nav.test', '/')).body, 'app');
});

test('the node-only /internal API is never exposed on the dashboard host', async () => {
  for (const p of ['/internal/v1/artifacts', '/internal', '/INTERNAL/v1/x?y=1']) {
    assert.equal((await request(edgePort, 'dashboard.nav.test', p)).status, 404, p);
  }
  const out = await new Promise<string>((resolve) => {
    const s = net.connect(edgePort, '127.0.0.1', () => s.write('GET /internal/v1/ws HTTP/1.1\r\nHost: dashboard.nav.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('close', () => resolve(buf));
  });
  assert.match(out, /^HTTP\/1\.1 404/);
});

test('WebSocket upgrades on the dashboard host reach the control plane', async () => {
  const echo = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: edgePort, path: '/api/v1/shell', agent: false, headers: { host: 'dashboard.nav.test', connection: 'Upgrade', upgrade: 'echo' } });
    req.on('upgrade', (_res, socket) => {
      socket.write('ls');
      socket.once('data', (d) => { resolve(d.toString()); socket.destroy(); });
    });
    req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
  assert.equal(echo, 'control:ls');
});

test('apex redirects to the dashboard host; HTTPS is forced once a certificate exists', async () => {
  const apex = await request(edgePort, 'nav.test', '/login?next=/');
  assert.equal(apex.status, 302);
  assert.equal(apex.headers.location, 'http://dashboard.nav.test/login?next=/');

  hasCert = true;
  try {
    const r = await request(edgePort, 'dashboard.nav.test', '/api/v1/x');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, 'https://dashboard.nav.test/api/v1/x');
    // ACME HTTP-01 still works on the dashboard host.
    assert.equal((await request(edgePort, 'dashboard.nav.test', '/.well-known/acme-challenge/abc')).status, 404);
  } finally {
    hasCert = false;
  }
});

test('control plane down: 502, and it is not ejected (served again as soon as it is back)', async () => {
  const closed = http.createServer();
  const deadPort = await listen(closed);
  await new Promise<void>((r) => closed.close(() => r()));
  const down = new Edge({ table: new RouteTable('nav.test'), log: () => {}, controlPlane: { host: 'dashboard.nav.test', target: { host: '127.0.0.1', port: deadPort } } });
  const srv = http.createServer();
  down.attach(srv, false);
  const port = await listen(srv);
  try {
    assert.equal((await request(port, 'dashboard.nav.test', '/api/v1/x')).status, 502);
    const back = http.createServer((_req, res) => res.end('back'));
    await new Promise<void>((r) => back.listen(deadPort, '127.0.0.1', () => r()));
    try {
      const r = await request(port, 'dashboard.nav.test', '/api/v1/x');
      assert.equal(r.status, 200);
      assert.equal(r.body, 'back');
    } finally {
      back.closeAllConnections();
      await new Promise<void>((r) => back.close(() => r()));
    }
  } finally {
    down.closeAll();
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
