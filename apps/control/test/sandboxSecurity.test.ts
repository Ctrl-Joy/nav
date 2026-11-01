// Sandbox hardening without a Docker Engine: which images are accepted, the always-pull-and-pin-by-digest image
// step, the host firewall rules for egress (as iptables argument lists), and audit redaction of exec commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { SANDBOX_IMAGES } from '@nav/shared';
import { pullSandboxImage } from '../src/agent/sandbox/docker.ts';
import { BLOCKED_RANGES, EGRESS_CHAIN, INPUT_CHAIN, egressFirewallSteps, parseResolvConf } from '../src/agent/sandbox/firewall.ts';
import { forbiddenImageReason, imageRepository, sandboxImageError } from '../src/lib/sandboxImages.ts';
import { redactCommand } from '../src/lib/sandboxes.ts';

test('sandbox images: defaults and allowlisted repositories only, never NAV builds or bare IDs', () => {
  for (const img of Object.values(SANDBOX_IMAGES)) assert.equal(sandboxImageError(img, []), null, img);
  assert.equal(sandboxImageError('docker.io/library/python:3.13-slim', []), null);
  assert.equal(sandboxImageError(`python:3.13-slim@sha256:${'a'.repeat(64)}`, []), null);
  assert.match(sandboxImageError('python:3.12', [])!, /allowlist/);
  assert.match(sandboxImageError('ghcr.io/evil/img:1', [])!, /allowlist/);
  for (const bad of ['nav/srv_abc:dep_1', 'NAV/srv_abc:dep_1', 'docker.io/nav/srv_x:1', `sha256:${'b'.repeat(64)}`, 'b'.repeat(64), 'b'.repeat(12), 'localhost:5000/x', '127.0.0.1:5000/x']) {
    assert.ok(sandboxImageError(bad, ['nav/', 'python', 'localhost:5000/', '127.0.0.1:5000/']), bad);
    assert.ok(forbiddenImageReason(bad), bad);
  }
  const prefixes = ['python', 'ghcr.io/acme/'];
  assert.equal(sandboxImageError('python:3.12', prefixes), null);
  assert.equal(sandboxImageError('ghcr.io/acme/tools:2', prefixes), null);
  assert.match(sandboxImageError('pythonx:1', prefixes)!, /allowlist/, 'a prefix never matches a longer repository name');
  assert.match(sandboxImageError('ghcr.io/acme-evil/tools:2', prefixes)!, /allowlist/);
  assert.equal(imageRepository('registry.example:5000/a/b:1@sha256:00'), 'registry.example:5000/a/b');
  assert.equal(imageRepository('python:3.13-slim'), 'python');
});

function fakeDocker(events: { status?: string; error?: string }[], pulled: { ref: string; opts: unknown }[]) {
  return {
    pull: async (ref: string, opts: unknown) => { pulled.push({ ref, opts }); return new PassThrough(); },
    modem: { followProgress: (_s: unknown, cb: (err: Error | null, res: unknown[]) => void) => cb(null, events) },
  } as never;
}

test('sandbox images are always pulled anonymously and run by the digest the pull reported', async () => {
  const pulled: { ref: string; opts: unknown }[] = [];
  const digest = `sha256:${'c'.repeat(64)}`;
  const ref = await pullSandboxImage(fakeDocker([{ status: 'Pulling from library/python' }, { status: `Digest: ${digest}` }, { status: 'Status: Image is up to date' }], pulled), 'python:3.13-slim');
  assert.equal(ref, `python@${digest}`);
  assert.deepEqual(pulled, [{ ref: 'python:3.13-slim', opts: {} }], 'no credentials are sent, and the local cache is never consulted');

  // A failed pull is an error: there is no fallback to whatever the node has cached under that name.
  await assert.rejects(pullSandboxImage(fakeDocker([{ error: 'pull access denied' }], []), 'python:3.13-slim'), /pull access denied/);
  await assert.rejects(pullSandboxImage(fakeDocker([{ status: 'done' }], []), 'python:3.13-slim'), /did not report a digest/);
  await assert.rejects(pullSandboxImage(fakeDocker([], pulled), 'nav/srv_1:dep_1'), /NAV build images/);
  await assert.rejects(pullSandboxImage(fakeDocker([], pulled), `sha256:${'d'.repeat(64)}`), /image IDs/);
  assert.equal(pulled.length, 1, 'forbidden references are never pulled');
});

test('egress firewall rules: private ranges and the node dropped for the sandbox subnet, DNS kept', () => {
  const steps = egressFirewallSteps({ subnet: '172.30.0.0/16', nodeAddresses: ['10.0.0.5', '203.0.113.7', 'fe80::1'], resolvers: ['10.0.0.2', '127.0.0.53'] });
  const args = steps.map((s) => s.args.join(' '));
  assert.equal(steps[0].args.join(' '), `-w -N ${EGRESS_CHAIN}`);
  assert.equal(steps[0].ignoreError, true, 'creating an existing chain is fine (idempotent)');
  assert.ok(args.includes(`-w -F ${EGRESS_CHAIN}`), 'the chain is flushed and rebuilt on every start');
  for (const range of [...BLOCKED_RANGES, '10.0.0.5/32', '203.0.113.7/32']) {
    assert.ok(args.includes(`-w -A ${EGRESS_CHAIN} -s 172.30.0.0/16 -d ${range} -j DROP`), range);
  }
  for (const r of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8']) assert.ok(BLOCKED_RANGES.includes(r), r);
  // DNS to the node's resolver is allowed before the drops; loopback resolvers are reached from the host namespace.
  const dns = args.indexOf(`-w -A ${EGRESS_CHAIN} -s 172.30.0.0/16 -d 10.0.0.2/32 -p udp --dport 53 -j RETURN`);
  assert.ok(dns >= 0 && dns < args.indexOf(`-w -A ${EGRESS_CHAIN} -s 172.30.0.0/16 -d 10.0.0.0/8 -j DROP`));
  assert.ok(args.includes(`-w -A ${EGRESS_CHAIN} -s 172.30.0.0/16 -d 10.0.0.2/32 -p tcp --dport 53 -j RETURN`));
  assert.ok(!args.some((a) => a.includes('127.0.0.53') || a.includes('fe80')));
  // App networks lose the metadata service.
  assert.ok(args.includes(`-w -A ${EGRESS_CHAIN} -i br-+ -d 169.254.0.0/16 -j DROP`));
  // Jumps are only inserted when missing.
  const jump = steps.find((s) => s.args.includes('DOCKER-USER'))!;
  assert.deepEqual(jump.check, ['-w', '-C', 'DOCKER-USER', '-j', EGRESS_CHAIN]);
  assert.deepEqual(jump.args, ['-w', '-I', 'DOCKER-USER', '1', '-j', EGRESS_CHAIN]);
  const input = steps.find((s) => s.args.includes('INPUT') && s.check)!;
  assert.deepEqual(input.check, ['-w', '-C', 'INPUT', '-j', INPUT_CHAIN]);
  assert.ok(args.includes(`-w -A ${INPUT_CHAIN} -s 172.30.0.0/16 -j DROP`), 'nothing on the node itself is reachable');
  assert.deepEqual(parseResolvConf('# x\nnameserver 10.0.0.2\nsearch a\n  nameserver 1.1.1.1\n'), ['10.0.0.2', '1.1.1.1']);
});

test('exec commands are audited with obvious inline secrets redacted', () => {
  const R = '[REDACTED]';
  const cases: [string, string][] = [
    ['psql --password=hunter2 -h db', `psql --password=${R} -h db`],
    ['tool --token abc123 --verbose', `tool --token ${R} --verbose`],
    ['GITHUB_TOKEN=ghp_abc npm publish', `GITHUB_TOKEN=${R} npm publish`],
    ['export AWS_SECRET_ACCESS_KEY="a b c" && run', `export AWS_SECRET_ACCESS_KEY=${R} && run`],
    ['curl -H "Authorization: Bearer eyJabc.def" https://x', `curl -H "Authorization: Bearer ${R}" https://x`],
    ['curl -H "x: 1" bearer abc.def', `curl -H "x: 1" bearer ${R}`],
    ['git clone https://user:s3cret@github.com/a/b', `git clone https://user:${R}@github.com/a/b`],
    ['mysql -u root -phunter2 db', `mysql -u root -p${R} db`],
    ['redis-cli -h r -a pass123 ping', `redis-cli -h r -a ${R} ping`],
  ];
  for (const [input, want] of cases) assert.equal(redactCommand(input), want, input);
  assert.equal(redactCommand('mkdir -p build && ls -la'), 'mkdir -p build && ls -la', 'ordinary commands are untouched');
  assert.equal(redactCommand('python main.py'), 'python main.py');
});
