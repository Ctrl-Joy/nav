import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { CertStore, ensureDevCerts, platformCertMonitor, wildcardFileLoader } from '../src/tls.ts';
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

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;

/** SHA-256 fingerprint of the certificate a server using `store` presents for `servername`. */
async function served(store: CertStore, servername: string): Promise<string> {
  const server = tls.createServer({ SNICallback: store.sniCallback, minVersion: 'TLSv1.2' }, (s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    return await new Promise<string>((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, servername, rejectUnauthorized: false }, () => {
        const fp = s.getPeerX509Certificate()!.fingerprint256;
        s.destroy();
        resolve(fp);
      });
      s.on('error', reject);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('platform wildcard: exact custom domain first, then *.<appsDomain> for the apex and one label, dev fallback last', async () => {
  const dev = ensureDevCerts(tmp('nav-pw-dev-'), 'nav.test');
  const acme = ensureDevCerts(tmp('nav-pw-acme-'), 'nav.test'); // stands in for the Let's Encrypt wildcard
  const shop = ensureDevCerts(tmp('nav-pw-shop-'), 'shop.example');
  const pinned = ensureDevCerts(tmp('nav-pw-pin-'), 'pinned.test');
  const store = new CertStore({ cert: dev.cert, key: dev.key }, (s) => s, () => {}, { appsDomain: 'nav.test' });
  assert.equal(store.platformSource(), null);
  assert.equal(await served(store, 'app.nav.test'), fingerprint(dev.cert));

  store.setRows([
    { domain: '*.nav.test', cert_pem: acme.cert, key_enc: acme.key },
    { domain: 'www.shop.example', cert_pem: shop.cert, key_enc: shop.key },
    { domain: 'api.nav.test', cert_pem: pinned.cert, key_enc: pinned.key },
  ]);
  assert.equal(store.platformSource(), 'acme');
  assert.equal(await served(store, 'app.nav.test'), fingerprint(acme.cert));
  assert.equal(await served(store, 'APP.nav.test.'), fingerprint(acme.cert));
  assert.equal(await served(store, 'nav.test'), fingerprint(acme.cert), 'apex');
  assert.equal(await served(store, 'api.nav.test'), fingerprint(pinned.cert), 'exact match wins over the wildcard');
  assert.equal(await served(store, 'www.shop.example'), fingerprint(shop.cert));
  assert.equal(await served(store, 'a.b.nav.test'), fingerprint(dev.cert), 'wildcards cover one label only');
  assert.equal(await served(store, 'evilnav.test'), fingerprint(dev.cert));
  assert.equal(await served(store, 'other.example'), fingerprint(dev.cert));
  assert.ok(store.hasCert('nav.test'));
  assert.equal(store.hasCert('x.y.nav.test'), false);

  // Operator files take precedence over the ACME row; clearing them falls back to it.
  const files = ensureDevCerts(tmp('nav-pw-files-'), 'nav.test');
  store.setPlatformFiles({ cert: files.cert, key: files.key });
  assert.equal(store.platformSource(), 'files');
  assert.equal(await served(store, 'app.nav.test'), fingerprint(files.cert));
  assert.equal(await served(store, 'api.nav.test'), fingerprint(pinned.cert));
  store.setPlatformFiles(null);
  assert.equal(await served(store, 'nav.test'), fingerprint(acme.cert));

  // Without an apps domain the store behaves as before: no apex match.
  const plain = new CertStore({ cert: dev.cert, key: dev.key }, (s) => s, () => {});
  plain.setRows([{ domain: '*.nav.test', cert_pem: acme.cert, key_enc: acme.key }]);
  assert.equal(plain.hasCert('nav.test'), false);
  assert.ok(plain.hasCert('app.nav.test'));
});

test('wildcard files are loaded, hot-reloaded on change, and a broken update keeps the last good certificate', async () => {
  const dev = ensureDevCerts(tmp('nav-wf-dev-'), 'nav.test');
  const one = ensureDevCerts(tmp('nav-wf-1-'), 'nav.test');
  const two = ensureDevCerts(tmp('nav-wf-2-'), 'nav.test');
  const dir = tmp('nav-wf-files-');
  const certFile = path.join(dir, 'fullchain.pem');
  const keyFile = path.join(dir, 'privkey.pem');
  const logs: string[] = [];
  const store = new CertStore({ cert: dev.cert, key: dev.key }, (s) => s, () => {}, { appsDomain: 'nav.test' });
  const load = wildcardFileLoader(store, certFile, keyFile, (m) => logs.push(m));
  const monitor = platformCertMonitor(store, 'nav.test', true, (m) => logs.push(m));

  await load(); // files do not exist yet
  await monitor();
  assert.equal(store.platformSource(), null);
  assert.ok(logs.some((l) => l.includes('unreadable')));
  assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('development certificate')));

  fs.writeFileSync(certFile, one.cert);
  fs.writeFileSync(keyFile, one.key);
  await load();
  await monitor();
  assert.equal(store.platformSource(), 'files');
  assert.equal(await served(store, 'app.nav.test'), fingerprint(one.cert));
  assert.ok(logs.some((l) => l.includes('operator-supplied')));

  // Renewed files (e.g. by certbot) are picked up on the next load; unchanged files are not re-read.
  fs.writeFileSync(certFile, two.cert);
  fs.writeFileSync(keyFile, two.key);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(certFile, future, future);
  await load();
  assert.equal(await served(store, 'nav.test'), fingerprint(two.cert));
  const before = logs.length;
  await load();
  assert.equal(logs.length, before);

  // A half-written / mismatched update is rejected.
  fs.writeFileSync(keyFile, one.key);
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(keyFile, later, later);
  await load();
  assert.ok(logs.at(-1)!.includes('invalid wildcard certificate'));
  assert.equal(await served(store, 'app.nav.test'), fingerprint(two.cert));
});
