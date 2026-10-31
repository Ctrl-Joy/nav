import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyParams, matchPath, matchRules } from '../src/match.ts';
import { RouteTable, normalizeRow, sanitizeHost, type EdgeRouteRow } from '../src/routes.ts';
import { decodePath, isHashedAsset, lookupFile, resolveSafe } from '../src/static.ts';
import { Balancer } from '../src/proxy.ts';
import { Metrics } from '../src/metrics.ts';

const row = (o: Partial<EdgeRouteRow> & { service_id: string; slug: string }): EdgeRouteRow => ({
  type: 'web', suspended: false, maintenance_mode: false, status: 'live', static_headers: [], static_routes: [],
  artifact: null, upstreams: [], domains: [], ...o,
});

test('sanitizeHost lowercases, strips port and validates', () => {
  assert.equal(sanitizeHost('My-App.NAV.localhost:8080'), 'my-app.nav.localhost');
  assert.equal(sanitizeHost('example.com.'), 'example.com');
  assert.equal(sanitizeHost('[::1]:8443'), '[::1]');
  assert.equal(sanitizeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(sanitizeHost(undefined), null);
  assert.equal(sanitizeHost(''), null);
  assert.equal(sanitizeHost('evil.com/path'), null);
  assert.equal(sanitizeHost('a b.com'), null);
  assert.equal(sanitizeHost('host:abc'), null);
  assert.equal(sanitizeHost('-bad.com'), null);
  assert.equal(sanitizeHost('a..b.com'), null);
  assert.equal(sanitizeHost('x'.repeat(300)), null);
});

test('RouteTable: slug hosts, custom domains, wildcard matches exactly one label', () => {
  const t = new RouteTable('nav.localhost');
  t.setRows([
    row({ service_id: 's1', slug: 'api', domains: [{ domain: 'api.example.com', redirectTo: null }, { domain: 'www.example.com', redirectTo: 'example.com' }] }),
    row({ service_id: 's2', slug: 'site', domains: JSON.stringify([{ domain: '*.example.org', redirectTo: null }]) }),
  ]);
  assert.equal(t.size, 2);
  assert.equal(t.lookup('api.nav.localhost')?.route.serviceId, 's1');
  assert.equal(t.lookup('api.example.com')?.route.serviceId, 's1');
  assert.equal(t.lookup('www.example.com')?.redirectTo, 'example.com');
  assert.equal(t.lookup('foo.example.org')?.route.serviceId, 's2');
  assert.equal(t.lookup('a.b.example.org'), null, 'wildcard must match one label only');
  assert.equal(t.lookup('example.org'), null);
  assert.equal(t.lookup('nope.nav.localhost'), null);
  assert.equal(t.lookup('nav.localhost'), null);
});

test('normalizeRow parses json columns and drops malformed upstreams', () => {
  const r = normalizeRow(row({
    service_id: 's', slug: 'X', upstreams: JSON.stringify([{ id: 'i1', host: '127.0.0.1', port: 3000 }, { id: 'bad' }]),
    artifact: '{"kind":"dir","path":"/tmp/x"}', static_routes: 'not json',
  }));
  assert.equal(r.slug, 'x');
  assert.deepEqual(r.upstreams, [{ id: 'i1', host: '127.0.0.1', port: 3000 }]);
  assert.deepEqual(r.artifact, { kind: 'dir', path: '/tmp/x' });
  assert.deepEqual(r.staticRoutes, []);
});

test('path patterns: exact, params, splat', () => {
  assert.deepEqual(matchPath('/about', '/about'), {});
  assert.deepEqual(matchPath('/about', '/about/'), {});
  assert.equal(matchPath('/about', '/about/team'), null);
  assert.deepEqual(matchPath('/blog/:year/:slug', '/blog/2024/hello'), { year: '2024', slug: 'hello' });
  assert.equal(matchPath('/blog/:year/:slug', '/blog/2024'), null);
  assert.deepEqual(matchPath('/old/*', '/old/a/b/c.html'), { splat: 'a/b/c.html' });
  assert.deepEqual(matchPath('/old/*', '/old'), { splat: '' });
  assert.equal(matchPath('/old/*', '/older'), null);
  assert.deepEqual(matchPath('/*', '/anything/here'), { splat: 'anything/here' });
  assert.deepEqual(matchPath('/a.b', '/a.b'), {});
  assert.equal(matchPath('/a.b', '/axb'), null, 'dots are literal');
  assert.deepEqual(matchPath('/files/*.png', '/files/x/y.png'), { splat: 'x/y' });
});

test('applyParams and matchRules: first match wins', () => {
  assert.equal(applyParams('/new/:splat', { splat: 'a/b' }), '/new/a/b');
  assert.equal(applyParams('/posts/:slug?y=:year', { slug: 's', year: '2020' }), '/posts/s?y=2020');
  assert.equal(applyParams('http://localhost:3000/:splat', { splat: 'x' }), 'http://localhost:3000/x');
  const rules = [
    { type: 'redirect' as const, source: '/old/*', destination: '/new/:splat' },
    { type: 'rewrite' as const, source: '/api/*', destination: 'https://api.example.com/:splat' },
    { type: 'rewrite' as const, source: '/*', destination: '/index.html' },
  ];
  assert.deepEqual(matchRules(rules, '/old/x/y'), { rule: rules[0], destination: '/new/x/y' });
  assert.equal(matchRules(rules, '/api/users')?.destination, 'https://api.example.com/users');
  assert.equal(matchRules(rules, '/dashboard')?.destination, '/index.html');
});

test('resolveSafe rejects traversal, null bytes, dotfiles, drive letters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-edge-root-'));
  assert.equal(resolveSafe(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveSafe(root, '/'), path.resolve(root));
  assert.equal(resolveSafe(root, '/a/b/c.js'), path.join(root, 'a', 'b', 'c.js'));
  for (const bad of [
    '/../etc/passwd', '/a/../../etc/passwd', '/..', '/a/..', '/./x', '/x\0.html', '/..\\..\\windows\\win.ini',
    '/C:/Windows/win.ini', '/x.txt:stream', '/.env', '/.git/config', '/a/.htpasswd', '/a/.well-known/x',
  ]) {
    assert.equal(resolveSafe(root, bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveSafe(root, '/.well-known/security.txt'), path.join(root, '.well-known', 'security.txt'));
  // encoded traversal is rejected once decoded
  assert.equal(resolveSafe(root, decodePath('/%2e%2e/%2e%2e/etc/passwd')!), null);
  assert.equal(resolveSafe(root, decodePath('/..%2f..%2fsecret')!), null);
  assert.equal(decodePath('/%00'), null);
  assert.equal(decodePath('/%E0%A4%A'), null);
  // sibling directory with a shared prefix must not be reachable
  const sibling = `${root}-evil`;
  assert.equal(resolveSafe(root, `/../${path.basename(sibling)}/x`), null);
});

test('lookupFile: index.html for directories, trailing slash redirect, .html fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-edge-lookup-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'index.html'), 'docs');
  fs.writeFileSync(path.join(root, 'about.html'), 'about');
  const r1 = lookupFile(root, '/docs/');
  assert.ok(r1 && 'file' in r1 && r1.file.endsWith(path.join('docs', 'index.html')));
  assert.deepEqual(lookupFile(root, '/docs'), { redirect: '/docs/' });
  const r2 = lookupFile(root, '/about');
  assert.ok(r2 && 'file' in r2 && r2.file.endsWith('about.html'));
  assert.equal(lookupFile(root, '/missing'), null);
});

test('isHashedAsset', () => {
  assert.equal(isHashedAsset('/assets/main.abc123.js'), true);
  assert.equal(isHashedAsset('/assets/index-BkQ3x9_a.js'), true);
  assert.equal(isHashedAsset('/chunk.8f3a2c1d.css'), true);
  assert.equal(isHashedAsset('/app.js'), false);
  assert.equal(isHashedAsset('/bootstrap-bundle.js'), false);
  assert.equal(isHashedAsset('/jquery.min.js'), false);
});

test('Balancer: round-robin, ejection, avoid', () => {
  const b = new Balancer(50);
  const a = { id: 'a', host: '127.0.0.1', port: 1 };
  const c = { id: 'c', host: '127.0.0.1', port: 2 };
  const picks = [0, 1, 2, 3].map(() => b.pick('s', [a, c])!.id);
  assert.deepEqual(picks, ['a', 'c', 'a', 'c']);
  b.eject(a);
  assert.deepEqual([0, 1, 2].map(() => b.pick('s', [a, c])!.id), ['c', 'c', 'c']);
  assert.equal(b.pick('s', [a, c], c)!.id, 'c', 'falls back to avoided upstream when it is the only healthy one');
  b.eject(c);
  assert.equal(b.pick('s', [a, c]), null);
  assert.equal(b.pick('s', []), null);
});

test('Metrics buckets and flush SQL; failures are swallowed and retained', async () => {
  const queries: { text: string; values?: unknown[] }[] = [];
  let fail = true;
  const m = new Metrics({ query: async (text, values) => { if (fail) throw new Error('db down'); queries.push({ text, values }); } }, () => {});
  const t0 = Date.parse('2026-01-01T00:00:10Z');
  m.record('s1', 200, 10, 100, t0);
  m.record('s1', 503, 30, 50, t0 + 5_000);
  m.record('s1', 404, 5, 10, t0 + 60_000);
  const snap = m.snapshot().sort((x, y) => x.minute.localeCompare(y.minute));
  assert.equal(snap.length, 2);
  assert.equal(snap[0].minute, '2026-01-01T00:00:00.000Z');
  assert.deepEqual([snap[0].requests, snap[0].s2xx, snap[0].s5xx, snap[0].latencySum, snap[0].latencyMax, snap[0].bytesOut], [2, 1, 1, 40, 30, 150]);
  await m.flush(); // fails, data kept (minutes are old relative to now -> dropped by the 15 min cutoff)
  fail = false;
  m.record('s2', 302, 1, 1);
  await m.flush();
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /ON CONFLICT \(service_id, minute\) DO UPDATE SET/);
  assert.match(queries[0].text, /requests = http_metrics\.requests \+ EXCLUDED\.requests/);
  assert.equal(queries[0].values?.[0], 's2');
  assert.equal(m.snapshot().length, 0);
});
