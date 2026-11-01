// The SSRF guard for user-supplied URLs and hosts: address classification (every IPv6 spelling of a private
// IPv4 address included), URL checks with private targets disallowed, and connection pinning to the checked address.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { config } from '@nav/shared/config';
import { assertPublicHost, assertPublicUrl, isPrivate, pinnedAgent, publicFetch, resolvePublicHost } from '../src/lib/targets.ts';
import { slackSignature } from '../src/scheduler/notifier.ts';

const allowBefore = config.allowPrivateTargets;
config.allowPrivateTargets = false;
after(() => { config.allowPrivateTargets = allowBefore; });

test('private, reserved and IPv4-embedding addresses are private in every spelling', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '100.127.255.255',
    '198.18.0.1', '198.19.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:169.254.169.254', '::FFFF:A9FE:A9FE', '::ffff:10.0.0.1',
    '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::169.254.169.254', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'ff02::1',
    'not-an-ip', '1.2.3', '::ffff:999.0.0.1',
  ]) assert.equal(isPrivate(ip), true, ip);
});

test('public addresses are not private', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '198.20.0.1', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:808:808', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPrivate(ip), false, ip);
  }
});

test('URLs and hosts naming private addresses are rejected when private targets are not allowed', async () => {
  for (const url of ['https://[::ffff:127.0.0.1]:4000/', 'https://[::ffff:169.254.169.254]/', 'https://[0:0:0:0:0:ffff:7f00:1]/', 'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/']) {
    await assert.rejects(assertPublicUrl(url), (e: { code?: string }) => e.code === 'private_target', url);
    await assert.rejects(publicFetch(url), (e: { code?: string }) => e.code === 'private_target', url);
  }
  for (const host of ['::ffff:7f00:1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', '[::ffff:127.0.0.1]', '169.254.169.254']) {
    await assert.rejects(assertPublicHost(host), (e: { code?: string }) => e.code === 'private_target', host);
  }
  await assert.rejects(assertPublicUrl('http://8.8.8.8/'), (e: { code?: string }) => e.code === 'bad_url', 'plain http');
});

test('a host is rejected when any address it resolves to is private', async () => {
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:10.0.0.5', family: 6 }];
  await assert.rejects(resolvePublicHost('rebind.example', resolver), (e: { code?: string }) => e.code === 'private_target');
  assert.deepEqual(await resolvePublicHost('ok.example', async () => [{ address: '93.184.216.34', family: 4 }]), { address: '93.184.216.34', family: 4 });
});

test('a pinned dispatcher connects to the checked address whatever the URL host resolves to', async () => {
  const srv = createServer((req, res) => res.end(`host=${req.headers.host}`));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const agent = pinnedAgent({ address: '127.0.0.1', family: 4 });
  try {
    // "nav-rebind.invalid" cannot resolve: the request only succeeds because the lookup is pinned.
    const res = await undiciFetch(`http://nav-rebind.invalid:${port}/`, { dispatcher: agent });
    assert.equal(await res.text(), `host=nav-rebind.invalid:${port}`);
  } finally {
    await agent.close();
    srv.close();
  }
});

test('the notification webhook is signed with a derived key, never the master key itself', () => {
  const master = 'm'.repeat(64);
  const sig = slackSignature('{"a":1}', master);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(sig, `sha256=${createHmac('sha256', master).update('{"a":1}').digest('hex')}`);
  const sub = createHmac('sha256', master).update('nav:slack-webhook:v1').digest();
  assert.equal(sig, `sha256=${createHmac('sha256', sub).update('{"a":1}').digest('hex')}`);
});
