// The docker sandbox driver's container spec and helper commands (no Docker Engine needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { SANDBOX_PLANS } from '@nav/shared';
import {
  SANDBOX_EGRESS_NETWORK, confineCommand, egressNetworkSpec, execCommand, killCommand, listCommand, parseListing, sandboxContainerSpec, stripTarPrefix,
} from '../src/agent/sandbox/docker.ts';
import type { SandboxSpec } from '../src/agent/sandbox/types.ts';

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  id: 'sbx_test1',
  workspaceId: 'ws_1',
  image: 'python:3.13-slim',
  runtime: 'python',
  plan: SANDBOX_PLANS[0],
  env: { FOO: 'bar' },
  networkAccess: 'none',
  ...over,
});

test('the sandbox container is locked down', () => {
  const c = sandboxContainerSpec(spec());
  const h = c.HostConfig!;
  assert.deepEqual(h.CapDrop, ['ALL']);
  assert.deepEqual(h.CapAdd, []);
  assert.ok(h.SecurityOpt?.includes('no-new-privileges:true'));
  assert.equal(h.Privileged, false);
  assert.equal(h.ReadonlyRootfs, true);
  assert.equal(h.Init, true);
  assert.equal(h.Memory, 512 * 1024 * 1024);
  assert.equal(h.MemorySwap, h.Memory, 'no swap beyond the memory limit');
  assert.equal(h.NanoCpus, 0.5e9);
  assert.equal(h.PidsLimit, SANDBOX_PLANS[0].pids);
  // The only writable places: the /workspace volume and small tmpfs mounts.
  assert.deepEqual(h.Mounts, [{ Type: 'volume', Source: 'nav-sbx-sbx_test1', Target: '/workspace' }]);
  assert.deepEqual(Object.keys(h.Tmpfs ?? {}).sort(), ['/home/sandbox', '/tmp']);
  for (const opts of Object.values(h.Tmpfs ?? {})) assert.match(opts, /nosuid/);
  assert.deepEqual(h.PortBindings, {});
  assert.equal(h.PublishAllPorts, false);
  assert.equal(c.WorkingDir, '/workspace');
  assert.deepEqual(c.Labels, { 'nav.sandbox': 'sbx_test1', 'nav.workspace': 'ws_1' });
});

test('no network unless egress is asked for', () => {
  const none = sandboxContainerSpec(spec());
  assert.equal(none.HostConfig!.NetworkMode, 'none');
  assert.equal(none.NetworkDisabled, true);
  const egress = sandboxContainerSpec(spec({ networkAccess: 'egress' }));
  assert.equal(egress.HostConfig!.NetworkMode, SANDBOX_EGRESS_NETWORK);
  assert.equal(egress.NetworkDisabled, false);
  // Sandboxes on the egress network cannot talk to each other.
  assert.equal(egressNetworkSpec().Options?.['com.docker.network.bridge.enable_icc'], 'false');
});

test('only the caller env (plus HOME and the id) reaches the container', () => {
  const before = process.env.NAV_MASTER_KEY;
  process.env.NAV_MASTER_KEY = 'super-secret';
  try {
    const env = sandboxContainerSpec(spec()).Env!;
    assert.deepEqual(env.sort(), ['FOO=bar', 'HOME=/home/sandbox', 'NAV_SANDBOX_ID=sbx_test1'].sort());
    assert.ok(!env.some((e) => e.includes('super-secret')));
  } finally {
    if (before === undefined) delete process.env.NAV_MASTER_KEY;
    else process.env.NAV_MASTER_KEY = before;
  }
});

test('commands are passed as arguments, never spliced into the script', () => {
  const evil = '"; rm -rf / #';
  const cmd = execCommand('abc', '/workspace/src', evil);
  assert.equal(cmd[0], '/bin/sh');
  assert.ok(!cmd[2].includes(evil));
  assert.deepEqual(cmd.slice(3), ['nav-exec', 'abc', '/workspace/src', evil]);
  // No command: a login shell.
  assert.match(execCommand('abc', '/workspace', null)[6], /exec (bash|sh) -l/);
  for (const c of [killCommand('abc'), confineCommand('/workspace/$(x)', 'read'), listCommand('/workspace/`x`')]) {
    assert.equal(c[0], '/bin/sh');
    assert.ok(!c[2].includes('$(x)') && !c[2].includes('`x`'));
  }
  assert.deepEqual(confineCommand('/workspace/a', 'write').slice(3), ['nav-confine', '/workspace/a', 'write']);
});

test('directory listings are parsed', () => {
  const raw = 'file\t12\t1700000000\tb.txt\0dir\t4096\t1700000000\tsrc\0symlink\t5\t1700000000\tlink\0';
  const items = parseListing(raw, ['app']);
  assert.deepEqual(items.map((i) => [i.type, i.name, i.path, i.size]), [
    ['dir', 'src', 'app/src', 0],
    ['file', 'b.txt', 'app/b.txt', 12],
    ['symlink', 'link', 'app/link', 0],
  ]);
  assert.equal(items[1].modifiedAt, new Date(1700000000 * 1000).toISOString());
});

test('workspace archives are re-rooted', async () => {
  const pack = tar.pack();
  pack.entry({ name: 'workspace/', type: 'directory' });
  pack.entry({ name: 'workspace/a.txt' }, 'hello');
  pack.entry({ name: 'workspace/sub/b.txt' }, 'world');
  pack.entry({ name: 'etc/passwd' }, 'nope');
  pack.finalize();
  const out = stripTarPrefix(pack as unknown as Readable, 'workspace');
  const ex = tar.extract();
  const seen: Record<string, string> = {};
  ex.on('entry', (h, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on('data', (d: unknown) => { chunks.push(d as Buffer); });
    stream.on('end', () => { seen[h.name] = Buffer.concat(chunks).toString(); next(); });
  });
  await new Promise<void>((resolve, reject) => { ex.on('finish', resolve); ex.on('error', reject); out.pipe(ex); });
  assert.deepEqual(seen, { 'a.txt': 'hello', 'sub/b.txt': 'world' });
});
