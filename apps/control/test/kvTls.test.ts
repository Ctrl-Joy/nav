// Key Value TLS proxy: a real TLS client through the proxy to a Redis-compatible server (Memurai when installed,
// otherwise a minimal RESP responder), CIDR enforcement per connection, certificate rotation and selection.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-kvtls-test-'));
process.env.NAV_DATA_DIR = path.join(dir, 'nav');
process.env.NAV_MASTER_KEY ??= 'a'.repeat(64);
process.env.NAV_APPS_DOMAIN = 'apps.example.test';
const { allowRules, generateSelfSigned, kvCertificate, nodeSelfSigned, startTlsProxy, fingerprintOf } = await import('../src/agent/kvTls.ts');
const { encrypt } = await import('@nav/shared/crypto');

const PASSWORD = 's3cret-pass';
const MEMURAI = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Memurai', 'memurai.exe');
let server: { port: number; stop: () => Promise<void>; kind: string };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Memurai on a spare port with requirepass, or a tiny RESP server that understands AUTH / PING / SET / GET. */
async function startBackend(): Promise<typeof server> {
  const port = await freePort();
  if (process.platform === 'win32' && existsSync(MEMURAI)) {
    const conf = path.join(dir, 'memurai.conf');
    await writeFile(conf, [`port ${port}`, 'bind 127.0.0.1', `requirepass ${PASSWORD}`, 'appendonly no', 'save ""', `dir ${dir.replace(/\\/g, '/')}`].join('\n') + '\n');
    const child: ChildProcess = spawn(MEMURAI, [conf], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      const up = await new Promise<boolean>((resolve) => net.connect(port, '127.0.0.1').once('connect', function (this: net.Socket) { this.destroy(); resolve(true); }).once('error', () => resolve(false)));
      if (up) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return { port, kind: 'memurai', stop: async () => { child.kill(); await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r))); } };
  }
  const store = new Map<string, string>();
  const srv = net.createServer((sock) => {
    let authed = false;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      // Inline commands only (what the test sends): one per line.
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const [cmd, ...args] = buf.slice(0, i).split(' ');
        buf = buf.slice(i + 2);
        const c = cmd.toUpperCase();
        if (c === 'AUTH') { authed = args.at(-1) === PASSWORD; sock.write(authed ? '+OK\r\n' : '-WRONGPASS invalid password\r\n'); }
        else if (!authed) sock.write('-NOAUTH Authentication required.\r\n');
        else if (c === 'PING') sock.write('+PONG\r\n');
        else if (c === 'SET') { store.set(args[0], args[1]); sock.write('+OK\r\n'); }
        else if (c === 'GET') { const v = store.get(args[0]); sock.write(v == null ? '$-1\r\n' : `$${v.length}\r\n${v}\r\n`); }
      }
    });
  });
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
  return { port, kind: 'fake', stop: () => new Promise((r) => srv.close(() => r())) };
}

before(async () => { server = await startBackend(); });
after(async () => {
  await server?.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const cert = generateSelfSigned({ dns: ['localhost'], ips: ['127.0.0.1'] });

/** Connects with TLS (verifying against `ca`), sends inline commands and collects `lines` reply lines. */
function session(port: number, ca: string, commands: string[], lines = commands.length): Promise<{ replies: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca }, () => {
      const fingerprint = sock.getPeerX509Certificate()!.fingerprint256;
      let out = '';
      sock.on('data', (d) => {
        out += d.toString();
        if (out.split('\r\n').length - 1 >= lines) { sock.end(); resolve({ replies: out, fingerprint }); }
      });
      sock.write(commands.map((c) => `${c}\r\n`).join(''));
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
  });
}

test(`TLS client reaches the server through the proxy (${process.platform === 'win32' && existsSync(MEMURAI) ? 'Memurai' : 'RESP stub'})`, async () => {
  const proxy = await startTlsProxy({ port: 0, host: '127.0.0.1', cert, allow: allowRules([{ cidr: '127.0.0.0/8' }]), upstream: { host: '127.0.0.1', port: server.port } });
  try {
    const r = await session(proxy.port, cert.cert, [`AUTH default ${PASSWORD}`, 'PING', 'SET nav tls-ok', 'GET nav'], 5);
    assert.equal(r.replies, '+OK\r\n+PONG\r\n+OK\r\n$6\r\ntls-ok\r\n');
    assert.equal(r.fingerprint, fingerprintOf(cert.cert));
    const wrong = await session(proxy.port, cert.cert, ['AUTH default nope']);
    assert.match(wrong.replies, /^-WRONGPASS/);
    // A plaintext Redis client gets no service from the TLS port.
    const plain = await new Promise<string>((resolve) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => s.write('PING\r\n'));
      let got = '';
      s.on('data', (d) => (got += d.toString('latin1')));
      s.on('close', () => resolve(got));
      s.on('error', () => {});
    });
    assert.ok(!plain.includes('PONG'));
  } finally {
    await proxy.close();
  }
});

test('connections from outside the allow list are dropped before the handshake', async () => {
  const logs: string[] = [];
  const proxy = await startTlsProxy({ port: 0, host: '127.0.0.1', cert, allow: allowRules([{ cidr: '203.0.113.0/24' }, { cidr: '2001:db8::/32' }]), upstream: { host: '127.0.0.1', port: server.port }, log: (m) => logs.push(m) });
  try {
    await assert.rejects(session(proxy.port, cert.cert, ['PING']), /socket disconnected|ECONNRESET|socket hang up/i);
    assert.match(logs.join('\n'), /Rejected TLS connection from 127\.0\.0\.1/);
    // Empty allow list: external access is off, nothing gets through.
    proxy.setAllow([]);
    await assert.rejects(session(proxy.port, cert.cert, ['PING']));
    // Allowing the client opens it up; narrowing the list again closes open connections.
    proxy.setAllow(allowRules([{ cidr: '127.0.0.1/32' }]));
    const sock = tls.connect({ host: '127.0.0.1', port: proxy.port, servername: 'localhost', ca: cert.cert });
    await new Promise<void>((resolve, reject) => { sock.once('secureConnect', () => resolve()); sock.once('error', reject); });
    const closed = new Promise<void>((resolve) => sock.once('close', () => resolve()));
    sock.on('error', () => {});
    proxy.setAllow(allowRules([{ cidr: '10.0.0.0/8' }]));
    await closed;
  } finally {
    await proxy.close();
  }
});

test('a rotated certificate is served to new connections', async () => {
  const next = generateSelfSigned({ dns: ['localhost'], ips: ['127.0.0.1'] });
  const proxy = await startTlsProxy({ port: 0, host: '127.0.0.1', cert, allow: allowRules([{ cidr: '127.0.0.1/32' }]), upstream: { host: '127.0.0.1', port: server.port } });
  try {
    assert.equal((await session(proxy.port, cert.cert, [`AUTH default ${PASSWORD}`])).fingerprint, fingerprintOf(cert.cert));
    proxy.setCert(next);
    assert.equal((await session(proxy.port, next.cert, [`AUTH default ${PASSWORD}`])).fingerprint, fingerprintOf(next.cert));
  } finally {
    await proxy.close();
  }
});

test('certificate selection: platform wildcard from the certificates table, else the node self-signed one', async () => {
  const platform = generateSelfSigned({ dns: ['*.apps.example.test', 'apps.example.test'], ips: [] });
  const seen: unknown[][] = [];
  const withRow = await kvCertificate(async (_sql, params) => { seen.push(params); return [{ cert_pem: platform.cert, key_enc: encrypt(platform.key) }]; });
  assert.equal(withRow.source, 'platform');
  assert.equal(withRow.fingerprint, fingerprintOf(platform.cert));
  assert.deepEqual(seen[0], ['*.apps.example.test']);

  const fallback = await kvCertificate(async () => []);
  assert.equal(fallback.source, 'self-signed');
  // Generated once per node and reused.
  const again = await nodeSelfSigned();
  assert.equal(fingerprintOf(again.cert), fallback.fingerprint);
  assert.equal(await readFile(path.join(dir, 'nav', 'keyvalue', 'tls', 'cert.pem'), 'utf8'), again.cert);
  // The database being unreachable also falls back instead of failing.
  assert.equal((await kvCertificate(async () => { throw new Error('db down'); })).source, 'self-signed');
});
