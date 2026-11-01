// Free instance sleep: requests to a sleeping web service are held while it wakes, then proxied.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Edge } from '../src/proxy.ts';
import { RouteTable, type EdgeRouteRow } from '../src/routes.ts';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, host: string, p = '/', headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host, ...headers }, agent: false }, (res) => {
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

const row = (o: Partial<EdgeRouteRow> & { service_id: string; slug: string }): EdgeRouteRow => ({
  type: 'web', suspended: false, maintenance_mode: false, status: 'live', static_headers: [], static_routes: [],
  artifact: null, upstreams: [], domains: [], ...o,
});

let up: http.Server, edgeServer: http.Server, edge: Edge, table: RouteTable;
let upPort = 0, edgePort = 0;
const wakes: string[] = [];
let rows: EdgeRouteRow[] = [];

/** Replaces one service's row, like a route reload after the control plane changed it. */
function setRow(serviceId: string, patch: Partial<EdgeRouteRow>): void {
  rows = rows.map((r) => (r.service_id === serviceId ? { ...r, ...patch } : r));
  table.setRows(rows);
}

before(async () => {
  up = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello ${req.url}`); });
  up.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => {});
  });
  upPort = await listen(up);
  table = new RouteTable('nav.test');
  rows = [
    row({ service_id: 'svc-nap', slug: 'nap', sleeping: true }),
    row({ service_id: 'svc-ws', slug: 'ws', sleeping: true }),
    row({ service_id: 'svc-stuck', slug: 'stuck', sleeping: true }),
    row({ service_id: 'svc-awake', slug: 'awake', upstreams: [{ id: 'i1', host: '127.0.0.1', port: 0 }] }),
  ];
  table.setRows(rows);
  edge = new Edge({
    table, log: () => {}, wakeTimeoutMs: 1_200, wakeSignalMs: 250,
    // Simulates the control plane: clear `sleeping` at once, the instance turns healthy a little later.
    wake: async (id) => {
      wakes.push(id);
      if (id === 'svc-stuck') return;
      setTimeout(() => setRow(id, { sleeping: false }), 50);
      setTimeout(() => setRow(id, { upstreams: [{ id: `${id}-i`, host: '127.0.0.1', port: upPort }] }), 300);
    },
  });
  edgeServer = http.createServer();
  edge.attach(edgeServer, false);
  edgePort = await listen(edgeServer);
});

after(async () => {
  edge.closeAll();
  edgeServer.closeAllConnections();
  up.closeAllConnections();
  await Promise.all([edgeServer, up].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

test('routes expose the sleeping flag', () => {
  assert.equal(table.lookup('nap.nav.test')?.route.sleeping, true);
  assert.equal(table.lookup('awake.nav.test')?.route.sleeping, false);
});

test('concurrent requests to a sleeping service share one wake and are proxied once it is up', async () => {
  const [a, b, c] = await Promise.all([1, 2, 3].map((i) => request(edgePort, 'nap.nav.test', `/r${i}`)));
  for (const [i, r] of [a, b, c].entries()) {
    assert.equal(r.status, 200);
    assert.equal(r.body, `hello /r${i + 1}`);
  }
  assert.equal([a, b, c].filter((r) => r.headers['x-nav-woke'] === '1').length, 1, 'only the request that started the wake is marked');
  assert.deepEqual(wakes.filter((w) => w === 'svc-nap'), ['svc-nap']);
  // Awake now: no hold, no header.
  const d = await request(edgePort, 'nap.nav.test', '/again');
  assert.equal(d.status, 200);
  assert.equal(d.headers['x-nav-woke'], undefined);
});

test('a service that does not come up in time gets the waking page with Retry-After; the signal is repeated', async () => {
  const t0 = Date.now();
  const r = await request(edgePort, 'stuck.nav.test', '/', { accept: 'application/json' });
  assert.ok(Date.now() - t0 >= 1_000, 'request was held');
  assert.equal(r.status, 503);
  assert.equal(r.headers['retry-after'], '10');
  assert.equal(JSON.parse(r.body).error.code, 'service_waking');
  assert.ok(wakes.filter((w) => w === 'svc-stuck').length >= 3, 'wake signal repeated while still asleep');
  const html = await request(edgePort, 'stuck.nav.test', '/');
  assert.match(html.body, /Waking up/);
});

test('a WebSocket upgrade wakes the service too', async () => {
  const out = await new Promise<string>((resolve, reject) => {
    const s = net.connect(edgePort, '127.0.0.1', () => s.write('GET /sock HTTP/1.1\r\nHost: ws.nav.test\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n') && !buf.includes('ping')) s.write('ping');
      if (buf.includes('ping')) { s.destroy(); resolve(buf); }
    });
    s.on('error', reject);
    s.setTimeout(3000, () => { s.destroy(); resolve(buf); });
  });
  assert.match(out, /^HTTP\/1\.1 101/);
  assert.match(out, /x-nav-woke: 1/i);
  assert.ok(wakes.includes('svc-ws'));
});
