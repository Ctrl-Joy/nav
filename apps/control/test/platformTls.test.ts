import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { cloudflareProvider, duckdnsProvider, duckdnsSubdomain, waitForTxt, type DnsProvider, type TxtResolver } from '../src/lib/dns.ts';
import { orderWildcard, platformCertNames, type AcmeOrderClient } from '../src/lib/platformTls.ts';

/** Minimal Cloudflare API v4: zones + dns_records, with the error codes the provider relies on. */
async function mockCloudflare(token: string) {
  const zones = [{ id: 'zone-1', name: 'example.com' }];
  const records = new Map<string, { id: string; zone: string; type: string; name: string; content: string }>();
  const calls: string[] = [];
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url!, 'http://x');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (json: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }, 403);
    if (url.pathname === '/client/v4/zones') return send({ success: true, result: zones.filter((z) => z.name === url.searchParams.get('name')) });
    const m = url.pathname.match(/^\/client\/v4\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (!m) return send({ success: false, errors: [{ code: 7003, message: 'no route' }], result: null }, 404);
    const [, zone, rid] = m;
    if (req.method === 'POST') {
      const r = JSON.parse(body);
      if ([...records.values()].some((x) => x.name === r.name && x.content === r.content)) return send({ success: false, errors: [{ code: 81058, message: 'An identical record already exists.' }], result: null }, 400);
      const rec = { id: `rec-${++seq}`, zone, type: r.type, name: r.name, content: r.content };
      records.set(rec.id, rec);
      return send({ success: true, result: rec });
    }
    if (req.method === 'GET') return send({ success: true, result: [...records.values()].filter((x) => x.zone === zone && x.type === url.searchParams.get('type') && x.name === url.searchParams.get('name')) });
    if (req.method === 'DELETE') {
      if (!records.delete(rid)) return send({ success: false, errors: [{ code: 81044, message: 'Record does not exist.' }], result: null }, 404);
      return send({ success: true, result: { id: rid } });
    }
    send({ success: false, errors: [{ code: 7001, message: 'method' }], result: null }, 405);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
  return { apiBase, records, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('cloudflare: zone found by walking up labels, two TXT values on one name, adopt leftovers, delete', async () => {
  const cf = await mockCloudflare('tok');
  try {
    const p = cloudflareProvider({ token: 'tok', apiBase: cf.apiBase });
    const name = '_acme-challenge.apps.example.com';
    const h1 = await p.createTxt(name, 'value-wildcard');
    const h2 = await p.createTxt(name, 'value-apex');
    assert.deepEqual(
      cf.calls.filter((c) => c.startsWith('GET /client/v4/zones?')).map((c) => new URL(c.slice(4), 'http://x').searchParams.get('name')),
      ['_acme-challenge.apps.example.com', 'apps.example.com', 'example.com'],
      'zone lookups walk up and are cached for the second record',
    );
    const txt = [...cf.records.values()].filter((r) => r.name === name);
    assert.deepEqual(txt.map((r) => [r.type, r.content]).sort(), [['TXT', '"value-apex"'], ['TXT', '"value-wildcard"']]);
    assert.notEqual(h1, h2);
    assert.match(h1, /^zone-1\//);

    // An identical record left over from an interrupted run is adopted rather than failing.
    const h3 = await p.createTxt(name, 'value-apex');
    assert.equal(h3, h2);

    await p.removeTxt(h1);
    await p.removeTxt(h2);
    await p.removeTxt(h2); // already gone: not an error
    assert.equal(cf.records.size, 0);

    await assert.rejects(p.createTxt('_acme-challenge.nav.other.org', 'x'), /no Cloudflare zone found/);
    await assert.rejects(cloudflareProvider({ token: 'wrong', apiBase: cf.apiBase }).createTxt(name, 'x'), /Authentication error \(10000\)/);
  } finally {
    await cf.close();
  }
});

test('waitForTxt: waits until every nameserver returns all values, then times out with the lagging servers', async () => {
  let polls = 0;
  const answers: Record<string, () => string[][]> = {
    // ns1 has both values at once; ns2 first has one, then both (one split into 255-byte style chunks).
    ns1: () => [['a'], ['b']],
    ns2: () => (polls < 3 ? [['a']] : [['a'], ['b']]),
  };
  const resolverFor = (server: string): TxtResolver => ({
    resolveTxt: async (name) => {
      assert.equal(name, '_acme-challenge.apps.example.com');
      if (server === 'ns2') polls++;
      return answers[server]();
    },
  });
  const logs: string[] = [];
  await waitForTxt('_acme-challenge.apps.example.com', ['a', 'b'], { servers: ['ns1', 'ns2'], resolverFor, intervalMs: 5, timeoutMs: 2000, log: (m) => logs.push(m) });
  assert.equal(polls, 3);
  assert.ok(logs.every((l) => l.includes('ns2') && !l.includes('ns1')));

  const chunked = (): TxtResolver => ({ resolveTxt: async () => [['ab', 'cd']] });
  await waitForTxt('x', ['abcd'], { servers: ['ns'], resolverFor: chunked, intervalMs: 5, timeoutMs: 100 });

  const failing = (s: string): TxtResolver => ({ resolveTxt: async () => { if (s === 'ns2') throw new Error('ENOTFOUND'); return [['a']]; } });
  await assert.rejects(
    waitForTxt('_acme-challenge.apps.example.com', ['a'], { servers: ['ns1', 'ns2'], resolverFor: failing, intervalMs: 10, timeoutMs: 50 }),
    /not visible on ns2 after/,
  );
});

function selfSigned(names: string[]): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 90 * 86400_000);
  const attrs = [{ name: 'commonName', value: 'Fake LE R10' }];
  cert.setSubject([{ name: 'commonName', value: names[0] }]);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/** Fake ACME server-side state machine recording the order of operations. */
function fakeAcme(opts: { reuseApex?: boolean; failChallenge?: boolean; domain?: string } = {}) {
  const domain = opts.domain ?? 'apps.example.com';
  const events: string[] = [];
  const challenge = (token: string) => ({ type: 'dns-01', url: `https://acme/chall/${token}`, status: 'pending', token });
  const client = {
    async createAccount(data: { contact?: string[] }) { events.push(`account ${data.contact?.join(',') ?? '-'}`); return {}; },
    async createOrder(data: { identifiers: Array<{ value: string }> }) { events.push(`order ${data.identifiers.map((i) => i.value).join(',')}`); return { url: 'order', finalize: 'f', authorizations: [] }; },
    async getAuthorizations() {
      return [
        { identifier: { type: 'dns', value: domain }, wildcard: true, status: 'pending', challenges: [{ type: 'http-01', url: 'x', status: 'pending', token: 'h' }, challenge('wild')] },
        { identifier: { type: 'dns', value: domain }, status: opts.reuseApex ? 'valid' : 'pending', challenges: [challenge('apex')] },
      ];
    },
    async getChallengeKeyAuthorization(c: { token: string }) { return `txt-${c.token}`; },
    async completeChallenge(c: { token: string }) {
      events.push(`complete ${c.token}`);
      if (opts.failChallenge) throw new Error('urn:ietf:params:acme:error:unauthorized: incorrect TXT record');
      return c;
    },
    async waitForValidStatus(c: unknown) { events.push('valid'); return c; },
    async finalizeOrder(order: unknown, csr: Buffer) { events.push(`finalize ${csr.length > 100}`); return order; },
    async getCertificate() { events.push('certificate'); return selfSigned([`*.${domain}`, domain]); },
  };
  return { events, client: client as unknown as AcmeOrderClient };
}

function fakeProvider(events: string[]): DnsProvider & { live: Map<string, string> } {
  const live = new Map<string, string>();
  let n = 0;
  return {
    name: 'fake',
    live,
    async createTxt(fqdn, value) { const h = `h${++n}`; live.set(h, `${fqdn}=${value}`); events.push(`create ${fqdn}=${value}`); return h; },
    async removeTxt(h) { events.push(`remove ${live.get(h)}`); live.delete(h); },
  };
}

test('orderWildcard: publishes both TXT values before validating, always cleans up, returns the certificate', async () => {
  const { events, client } = fakeAcme();
  const provider = fakeProvider(events);
  const cert = await orderWildcard({
    appsDomain: 'apps.example.com', client, provider, email: 'ops@example.com',
    waitFor: async (fqdn, values) => { events.push(`wait ${fqdn} ${values.join('+')}`); },
  });
  assert.deepEqual(events, [
    'account mailto:ops@example.com',
    'order *.apps.example.com,apps.example.com',
    'create _acme-challenge.apps.example.com=txt-wild',
    'create _acme-challenge.apps.example.com=txt-apex',
    'wait _acme-challenge.apps.example.com txt-wild+txt-apex',
    'complete wild', 'valid', 'complete apex', 'valid',
    'remove _acme-challenge.apps.example.com=txt-wild',
    'remove _acme-challenge.apps.example.com=txt-apex',
    'finalize true',
    'certificate',
  ]);
  assert.equal(provider.live.size, 0);
  assert.equal(cert.issuer, 'Fake LE R10');
  assert.ok(cert.notAfter.getTime() > Date.now() + 80 * 86400_000);
  assert.match(cert.keyPem, /PRIVATE KEY/);

  // A failed validation still removes every record; already-valid authorizations need no record.
  const failing = fakeAcme({ failChallenge: true, reuseApex: true });
  const p2 = fakeProvider(failing.events);
  await assert.rejects(orderWildcard({ appsDomain: 'apps.example.com', client: failing.client, provider: p2, waitFor: async () => {} }), /incorrect TXT record/);
  assert.equal(p2.live.size, 0);
  assert.deepEqual(failing.events.filter((e) => e.startsWith('create') || e.startsWith('remove')), [
    'create _acme-challenge.apps.example.com=txt-wild',
    'remove _acme-challenge.apps.example.com=txt-wild',
  ]);
  assert.equal(failing.events[0], 'account -');

  // Propagation timeout: records are removed and nothing is submitted to the CA.
  const slow = fakeAcme();
  const p3 = fakeProvider(slow.events);
  await assert.rejects(orderWildcard({ appsDomain: 'apps.example.com', client: slow.client, provider: p3, waitFor: async () => { throw new Error('TXT record not visible'); } }), /not visible/);
  assert.equal(p3.live.size, 0);
  assert.ok(!slow.events.some((e) => e.startsWith('complete')));
});

/** Minimal DuckDNS update API: one TXT value per subdomain, plain-text OK/KO answers like the real service. */
async function mockDuckDns(token: string, owned = ['onnav']) {
  const txt = new Map<string, string>();
  const calls: Array<Record<string, string>> = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const p = Object.fromEntries(url.searchParams);
    calls.push(p);
    if (failNext > 0) { failNext--; res.writeHead(500); res.end('oops'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (url.pathname !== '/update' || p.token !== token || !owned.includes(p.domains)) { res.end('KO'); return; }
    if (p.clear === 'true') txt.delete(p.domains);
    else if (p.txt !== undefined) txt.set(p.domains, p.txt);
    res.end(p.verbose === 'true' ? `OK\n${txt.get(p.domains) ?? ''}\n\nUPDATED` : 'OK');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { apiBase, txt, calls, failOnce: () => { failNext = 1; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('duckdnsSubdomain: the first label below duckdns.org, anything else is rejected', () => {
  assert.equal(duckdnsSubdomain('onnav.duckdns.org'), 'onnav');
  assert.equal(duckdnsSubdomain('_acme-challenge.onnav.duckdns.org'), 'onnav');
  assert.equal(duckdnsSubdomain('apps.OnNav.duckdns.org.'), 'onnav');
  assert.throws(() => duckdnsSubdomain('apps.example.com'), /not a duckdns.org name/);
  assert.throws(() => duckdnsSubdomain('duckdns.org'), /not a duckdns.org name/);
  assert.throws(() => duckdnsSubdomain('-bad.duckdns.org'), /no valid DuckDNS subdomain/);
  assert.throws(() => duckdnsProvider({ token: 't', domain: 'apps.example.com' }), /NAV_APPS_DOMAIN=<sub>.duckdns.org/);
});

test('duckdns: set and clear the TXT value, verbose responses, KO and HTTP errors never leak the token', async () => {
  const dd = await mockDuckDns('secret-token');
  try {
    const p = duckdnsProvider({ token: 'secret-token', domain: 'onnav.duckdns.org', apiBase: dd.apiBase });
    assert.equal(p.singleTxt, true);
    const h = await p.createTxt('_acme-challenge.onnav.duckdns.org', 'value-1');
    assert.equal(h, 'onnav');
    assert.equal(dd.txt.get('onnav'), 'value-1');
    assert.deepEqual(dd.calls[0], { domains: 'onnav', token: 'secret-token', txt: 'value-1', verbose: 'true' });
    // A second value replaces the first (DuckDNS holds a single TXT value).
    await p.createTxt('_acme-challenge.onnav.duckdns.org', 'value-2');
    assert.equal(dd.txt.get('onnav'), 'value-2');
    await p.removeTxt(h);
    assert.equal(dd.txt.has('onnav'), false);
    assert.equal(dd.calls.at(-1)?.clear, 'true');

    await assert.rejects(p.createTxt('_acme-challenge.other.duckdns.org', 'x'), /configured for onnav.duckdns.org/);
    await assert.rejects(p.removeTxt('other'), /unknown DuckDNS record handle/);

    const wrong = duckdnsProvider({ token: 'wrong-token', domain: 'onnav.duckdns.org', apiBase: dd.apiBase });
    const ko = await wrong.createTxt('_acme-challenge.onnav.duckdns.org', 'x').then(() => null, (e: Error) => e);
    assert.match(ko?.message ?? '', /refused \(KO\): check NAV_DUCKDNS_TOKEN/);
    assert.doesNotMatch(ko?.message ?? '', /wrong-token/);
    const notOwned = duckdnsProvider({ token: 'secret-token', domain: 'theirs.duckdns.org', apiBase: dd.apiBase });
    await assert.rejects(notOwned.removeTxt('theirs'), /clearing the TXT record of theirs.duckdns.org was refused \(KO\)/);

    dd.failOnce();
    await assert.rejects(p.createTxt('_acme-challenge.onnav.duckdns.org', 'x'), /HTTP 500/);
    const down = duckdnsProvider({ token: 'secret-token', domain: 'onnav.duckdns.org', apiBase: 'http://127.0.0.1:1' });
    const netErr = await down.createTxt('onnav.duckdns.org', 'x').then(() => null, (e: Error) => e);
    assert.match(netErr?.message ?? '', /setting the TXT record of onnav.duckdns.org failed/);
    assert.doesNotMatch(netErr?.message ?? '', /secret-token/);
  } finally {
    await dd.close();
  }
});

test('orderWildcard with a single-TXT provider: wildcard only by default, authorizations validated one at a time', async () => {
  // Default: only *.<d> is ordered.
  const one = fakeAcme();
  const p1 = Object.assign(fakeProvider(one.events), { singleTxt: true });
  await orderWildcard({ appsDomain: 'apps.example.com', client: one.client, provider: p1, waitFor: async () => {} });
  assert.equal(one.events[1], 'order *.apps.example.com');

  // With the apex too: each value is published, checked, validated and removed before the next one is published.
  const seq = fakeAcme();
  const p2 = Object.assign(fakeProvider(seq.events), { singleTxt: true });
  await orderWildcard({
    appsDomain: 'apps.example.com', client: seq.client, provider: p2, includeApex: true,
    waitFor: async (fqdn, values) => { seq.events.push(`wait ${fqdn} ${values.join('+')} live=${p2.live.size}`); },
  });
  assert.deepEqual(seq.events.slice(1), [
    'order *.apps.example.com,apps.example.com',
    'create _acme-challenge.apps.example.com=txt-wild',
    'wait _acme-challenge.apps.example.com txt-wild live=1',
    'complete wild', 'valid',
    'remove _acme-challenge.apps.example.com=txt-wild',
    'create _acme-challenge.apps.example.com=txt-apex',
    'wait _acme-challenge.apps.example.com txt-apex live=1',
    'complete apex', 'valid',
    'remove _acme-challenge.apps.example.com=txt-apex',
    'finalize true',
    'certificate',
  ]);
  assert.equal(p2.live.size, 0);

  // A failure stops at that authorization and still removes its record.
  const bad = fakeAcme({ failChallenge: true });
  const p3 = Object.assign(fakeProvider(bad.events), { singleTxt: true });
  await assert.rejects(orderWildcard({ appsDomain: 'apps.example.com', client: bad.client, provider: p3, includeApex: true, waitFor: async () => {} }), /incorrect TXT record/);
  assert.equal(p3.live.size, 0);
  assert.deepEqual(bad.events.filter((e) => /^(create|remove|complete)/.test(e)), [
    'create _acme-challenge.apps.example.com=txt-wild',
    'complete wild',
    'remove _acme-challenge.apps.example.com=txt-wild',
  ]);

  // A propagation timeout removes the record and submits nothing.
  const slow = fakeAcme();
  const p4 = Object.assign(fakeProvider(slow.events), { singleTxt: true });
  await assert.rejects(orderWildcard({ appsDomain: 'apps.example.com', client: slow.client, provider: p4, waitFor: async () => { throw new Error('TXT record not visible'); } }), /not visible/);
  assert.equal(p4.live.size, 0);
  assert.ok(!slow.events.some((e) => e.startsWith('complete')));

  assert.deepEqual(platformCertNames('onnav.duckdns.org', { singleTxt: true }), ['*.onnav.duckdns.org']);
  assert.deepEqual(platformCertNames('apps.example.com', null), ['*.apps.example.com', 'apps.example.com']);
});

test('orderWildcard against the DuckDNS mock: each value is served alone while it is checked, then cleared', async () => {
  const dd = await mockDuckDns('tok');
  try {
    const { events, client } = fakeAcme({ domain: 'onnav.duckdns.org' });
    const provider = duckdnsProvider({ token: 'tok', domain: 'onnav.duckdns.org', apiBase: dd.apiBase });
    const seen: string[] = [];
    await orderWildcard({
      appsDomain: 'onnav.duckdns.org', client, provider, includeApex: true,
      waitFor: async (fqdn, values) => { seen.push(`${fqdn} ${values.join('+')} served=${dd.txt.get('onnav')}`); },
    });
    assert.equal(events[1], 'order *.onnav.duckdns.org,onnav.duckdns.org');
    assert.deepEqual(seen, ['_acme-challenge.onnav.duckdns.org txt-wild served=txt-wild', '_acme-challenge.onnav.duckdns.org txt-apex served=txt-apex']);
    assert.equal(dd.txt.has('onnav'), false);
    assert.deepEqual(dd.calls.map((c) => (c.clear ? 'clear' : `set ${c.txt}`)), ['set txt-wild', 'clear', 'set txt-apex', 'clear']);
  } finally {
    await dd.close();
  }
});
