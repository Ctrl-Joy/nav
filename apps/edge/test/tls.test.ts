import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { CertStore, ensureDevCerts } from '../src/tls.ts';
import { Edge } from '../src/proxy.ts';
import { RouteTable } from '../src/routes.ts';

test('dev CA + wildcard cert generated once, reused, SNI selection, HTTPS proxying', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-edge-tls-'));
  const first = ensureDevCerts(dataDir, 'nav.test');
  assert.equal(first.generated, true);
  for (const f of ['ca.pem', 'ca-key.pem', 'wildcard.pem', 'wildcard-key.pem']) assert.ok(fs.existsSync(path.join(dataDir, 'edge', f)), f);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dataDir, 'edge', 'ca-key.pem')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'edge', 'wildcard-key.pem')).mode & 0o777, 0o600);
  }
  const second = ensureDevCerts(dataDir, 'nav.test');
  assert.equal(second.generated, false);
  assert.equal(second.cert, first.cert);
  // changing the apps domain re-issues the leaf with the same CA
  const other = ensureDevCerts(dataDir, 'other.test');
  assert.equal(other.ca, first.ca);
  assert.notEqual(other.cert, first.cert);
  const dev = ensureDevCerts(dataDir, 'nav.test');

  // A "custom" cert for *.custom.test stored "encrypted" (identity here).
  const store = new CertStore({ cert: dev.cert, key: dev.key }, (s) => s, () => {});
  const custom = ensureDevCerts(fs.mkdtempSync(path.join(os.tmpdir(), 'nav-edge-tls2-')), 'custom.test');
  store.setRows([{ domain: '*.custom.test', cert_pem: custom.cert, key_enc: custom.key }, { domain: 'broken.test', cert_pem: 'x', key_enc: 'y' }]);
  assert.equal(store.size, 1);
  assert.ok(store.hasCert('app.custom.test'));
  assert.equal(store.hasCert('a.b.custom.test'), false);
  assert.equal(store.hasCert('app.nav.test'), false);

  const up = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  const table = new RouteTable('nav.test');
  table.setRows([{ service_id: 's', slug: 'app', type: 'web', suspended: false, maintenance_mode: false, upstreams: [{ id: 'i', host: '127.0.0.1', port: (up.address() as AddressInfo).port }], domains: [] }]);
  const edge = new Edge({ table, log: () => {} });
  const server = https.createServer({ cert: dev.cert, key: dev.key, SNICallback: store.sniCallback, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
  edge.attach(server, true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;

  const body = await new Promise<string>((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: '/', servername: 'app.nav.test', headers: { host: 'app.nav.test' }, ca: dev.ca, agent: false }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.equal(JSON.parse(body)['x-forwarded-proto'], 'https');

  const peerCN = await new Promise<string>((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'app.custom.test', ca: [dev.ca, custom.ca] }, () => {
      const cn = s.getPeerCertificate().subject.CN;
      s.end();
      resolve(String(cn));
    });
    s.on('error', reject);
  });
  assert.equal(peerCN, '*.custom.test');

  await assert.rejects(new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'app.nav.test', ca: dev.ca, maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }, () => { s.end(); resolve(null); });
    s.on('error', reject);
  }));

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => up.close(() => r()));
  edge.closeAll();
});
