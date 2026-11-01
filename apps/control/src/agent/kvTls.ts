// Key Value external access over TLS. Instances with an IP allow list get a TLS-terminating proxy on this node:
// it listens on the instance's tls_port (rediss://), drops connections from addresses outside the allow list
// before the handshake, and pipes the decrypted stream to the instance's private plaintext port.
// Certificate: the platform wildcard for `*.<appsDomain>` (ACME, from `certificates`, or the operator's manual
// files) when there is one, so clients can verify `<slug>.<appsDomain>`; otherwise a self-signed certificate
// generated once per node under <dataDir>/keyvalue/tls (clients must pin it or skip verification).
import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { config } from '@nav/shared/config';
import { decrypt } from '@nav/shared/crypto';
import { ipAllowed, parseCidr, type Cidr } from '@nav/shared/cidr';

export interface KvCert { cert: string; key: string; source: 'platform' | 'self-signed'; fingerprint: string }

export const fingerprintOf = (certPem: string) => new X509Certificate(certPem).fingerprint256;

/** Parses `[{cidr}]` rules; invalid entries are dropped (the API validates them on the way in). */
export function allowRules(list: { cidr: string }[] | null | undefined): Cidr[] {
  return (list ?? []).map((r) => parseCidr(r.cidr)).filter((c): c is Cidr => c !== null);
}

// --- certificates ------------------------------------------------------------------------------

/** A self-signed server certificate for this node: its addresses, the hostname and the apps-domain names. */
export function generateSelfSigned(names: { dns: string[]; ips: string[] }, days = 825): { cert: string; key: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const fkey = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.setRsaPublicKey(fkey.n, fkey.e);
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  c.serialNumber = serial.toString('hex');
  c.validity.notBefore = new Date(Date.now() - 60_000);
  c.validity.notAfter = new Date(Date.now() + days * 86400_000);
  const subject = [{ name: 'commonName', value: names.dns[0] ?? names.ips[0] ?? 'nav-keyvalue' }, { name: 'organizationName', value: 'NAV Key Value (self-signed)' }];
  c.setSubject(subject);
  c.setIssuer(subject);
  c.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...names.dns.map((value) => ({ type: 2, value })), ...names.ips.map((ip) => ({ type: 7, ip }))] },
  ]);
  c.sign(fkey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: privateKey };
}

function usable(certPem: string, minDays: number): boolean {
  try {
    return Date.parse(new X509Certificate(certPem).validTo) - Date.now() > minDays * 86400_000;
  } catch {
    return false;
  }
}

/** Load (or create on first use, or when it expires within 30 days) this node's self-signed certificate. */
export async function nodeSelfSigned(dir = path.join(config.dataDir, 'keyvalue', 'tls')): Promise<{ cert: string; key: string }> {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const [cert, key] = await Promise.all([fs.readFile(certPath, 'utf8'), fs.readFile(keyPath, 'utf8')]).catch(() => [null, null]);
  if (cert && key && usable(cert, 30)) return { cert, key };
  const ips = [...new Set([config.nodeAddress, config.edgePublicIp, '127.0.0.1'].filter((ip) => net.isIP(ip)))];
  const fresh = generateSelfSigned({ dns: [...new Set([os.hostname(), `*.${config.appsDomain}`, 'localhost'])], ips });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(keyPath, fresh.key, { mode: 0o600 });
  await fs.writeFile(certPath, fresh.cert);
  return fresh;
}

type Query = (sql: string, params: unknown[]) => Promise<{ cert_pem: string; key_enc: string }[]>;

/**
 * The certificate the proxies serve. Preference: the ACME platform wildcard in `certificates` (valid for at least
 * another day), the operator's wildcard files (NAV_DNS_PROVIDER=manual, if readable on this node), else self-signed.
 */
export async function kvCertificate(query: Query): Promise<KvCert> {
  const rows = await query("SELECT cert_pem, key_enc FROM certificates WHERE domain = $1 AND not_after > now() + interval '1 day'", [`*.${config.appsDomain}`]).catch(() => []);
  if (rows[0]) {
    try {
      const key = decrypt(rows[0].key_enc);
      tls.createSecureContext({ cert: rows[0].cert_pem, key });
      return { cert: rows[0].cert_pem, key, source: 'platform', fingerprint: fingerprintOf(rows[0].cert_pem) };
    } catch { /* unusable: fall through */ }
  }
  const { certFile, keyFile } = config.platformTls;
  if (config.platformTls.dnsProvider === 'manual' && certFile && keyFile) {
    try {
      const [cert, key] = await Promise.all([fs.readFile(certFile, 'utf8'), fs.readFile(keyFile, 'utf8')]);
      tls.createSecureContext({ cert, key });
      if (usable(cert, 0)) return { cert, key, source: 'platform', fingerprint: fingerprintOf(cert) };
    } catch { /* not on this node / invalid: fall through */ }
  }
  const self = await nodeSelfSigned();
  return { ...self, source: 'self-signed', fingerprint: fingerprintOf(self.cert) };
}

// --- proxy -------------------------------------------------------------------------------------

export interface TlsProxyOptions {
  port: number;
  /** Interface to listen on; default: all (IPv4 and IPv6). */
  host?: string;
  cert: { cert: string; key: string };
  allow: Cidr[];
  upstream: { host: string; port: number };
  log?: (m: string, level?: string) => void;
}

export interface TlsProxy {
  readonly port: number;
  setCert(cert: { cert: string; key: string }): void;
  setAllow(allow: Cidr[]): void;
  close(): Promise<void>;
}

/** An allow list is mandatory: an empty one blocks everything (external access is off). */
export async function startTlsProxy(o: TlsProxyOptions): Promise<TlsProxy> {
  let allow = o.allow;
  const log = o.log ?? (() => {});
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ cert: o.cert.cert, key: o.cert.key, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 });

  // Raw TCP connection, before any TLS bytes: enforce the allow list here so blocked clients never get a handshake.
  server.on('connection', (raw: net.Socket) => {
    if (!allow.length || !ipAllowed(raw.remoteAddress, allow)) {
      log(`==> Rejected TLS connection from ${raw.remoteAddress ?? 'unknown'} (not in the inbound IP rules)`, 'warn');
      raw.destroy();
      return;
    }
    sockets.add(raw);
    raw.once('close', () => sockets.delete(raw));
  });
  server.on('tlsClientError', () => { /* failed handshakes and rejected sockets: nothing to clean up */ });

  server.on('secureConnection', (client: tls.TLSSocket) => {
    const upstream = net.connect({ host: o.upstream.host, port: o.upstream.port });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.setKeepAlive(true, 60_000);
    const done = () => { client.destroy(); upstream.destroy(); };
    client.on('error', done);
    upstream.on('error', (err) => { log(`==> TLS proxy upstream error: ${err.message}`, 'error'); done(); });
    client.on('close', done);
    upstream.on('close', done);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: o.port, host: o.host }, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', (err) => log(`==> TLS proxy error: ${err.message}`, 'error'));

  return {
    port: (server.address() as net.AddressInfo).port,
    setCert: (cert) => server.setSecureContext({ cert: cert.cert, key: cert.key, minVersion: 'TLSv1.2' }),
    setAllow: (next) => {
      allow = next;
      // Open connections from addresses that are no longer allowed are closed too.
      for (const s of sockets) if (!allow.length || !ipAllowed(s.remoteAddress, allow)) s.destroy();
    },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

