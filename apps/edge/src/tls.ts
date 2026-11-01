// TLS: SNI certificate selection from the `certificates` table (custom domains and the platform wildcard) or
// operator-supplied wildcard files, plus a self-generated local dev CA + wildcard used as the last-resort fallback.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';
import type pg from 'pg';

export interface DevCerts {
  dir: string;
  caPath: string;
  cert: string;
  key: string;
  ca: string;
  generated: boolean;
}

function rsaKey(): { pem: string; forgeKey: forge.pki.rsa.PrivateKey; forgePub: forge.pki.rsa.PublicKey } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const forgeKey = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  const forgePub = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
  return { pem: privateKey, forgeKey, forgePub };
}

function serial(): string {
  const b = randomBytes(16);
  b[0] &= 0x7f; // positive
  return b.toString('hex');
}

function writeSecret(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
}

function generateCa(): { cert: string; key: string } {
  const k = rsaKey();
  const c = forge.pki.createCertificate();
  c.publicKey = k.forgePub;
  c.serialNumber = serial();
  c.validity.notBefore = new Date(Date.now() - 60_000);
  c.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000);
  const attrs = [{ name: 'commonName', value: 'NAV Local Development CA' }, { name: 'organizationName', value: 'NAV (local)' }];
  c.setSubject(attrs);
  c.setIssuer(attrs);
  c.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  c.sign(k.forgeKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: k.pem };
}

function generateLeaf(appsDomain: string, caCertPem: string, caKeyPem: string): { cert: string; key: string } {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const k = rsaKey();
  const c = forge.pki.createCertificate();
  c.publicKey = k.forgePub;
  c.serialNumber = serial();
  c.validity.notBefore = new Date(Date.now() - 60_000);
  c.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600_000);
  c.setSubject([{ name: 'commonName', value: `*.${appsDomain}` }]);
  c.setIssuer(caCert.subject.attributes);
  c.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: `*.${appsDomain}` },
        { type: 2, value: appsDomain },
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
    { name: 'subjectKeyIdentifier' },
  ]);
  c.sign(caKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: k.pem };
}

function leafUsable(certPem: string, appsDomain: string): boolean {
  try {
    const x = new X509Certificate(certPem);
    if (Date.parse(x.validTo) - Date.now() < 30 * 24 * 3600_000) return false;
    const san = x.subjectAltName ?? '';
    return san.includes(`DNS:*.${appsDomain}`) && san.includes(`DNS:${appsDomain}`);
  } catch {
    return false;
  }
}

/** Load (or create on first start) the dev CA and wildcard cert under `<dataDir>/edge/`. */
export function ensureDevCerts(dataDir: string, appsDomain: string): DevCerts {
  const dir = path.join(dataDir, 'edge');
  fs.mkdirSync(dir, { recursive: true });
  const caPath = path.join(dir, 'ca.pem');
  const caKeyPath = path.join(dir, 'ca-key.pem');
  const certPath = path.join(dir, 'wildcard.pem');
  const keyPath = path.join(dir, 'wildcard-key.pem');
  let generated = false;

  let ca: string;
  let caKey: string;
  if (fs.existsSync(caPath) && fs.existsSync(caKeyPath)) {
    ca = fs.readFileSync(caPath, 'utf8');
    caKey = fs.readFileSync(caKeyPath, 'utf8');
  } else {
    ({ cert: ca, key: caKey } = generateCa());
    writeSecret(caKeyPath, caKey);
    fs.writeFileSync(caPath, ca);
    generated = true;
  }

  let cert: string | null = null;
  let key: string | null = null;
  if (!generated && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    cert = fs.readFileSync(certPath, 'utf8');
    key = fs.readFileSync(keyPath, 'utf8');
    if (!leafUsable(cert, appsDomain)) { cert = null; key = null; }
  }
  if (!cert || !key) {
    ({ cert, key } = generateLeaf(appsDomain, ca, caKey));
    writeSecret(keyPath, key);
    fs.writeFileSync(certPath, cert);
    generated = true;
  }
  return { dir, caPath, cert, key, ca, generated };
}

// --- SNI certificate store --------------------------------------------------------------------

export interface CertRow { domain: string; cert_pem: string; key_enc: string }

/**
 * Selection order: exact custom-domain certificate; for `<appsDomain>` and names exactly one label under it the
 * platform wildcard (operator files, else the ACME one stored as '*.<appsDomain>'); other one-label wildcards;
 * otherwise null and the SNI callback serves the self-signed development certificate.
 */
export class CertStore {
  private contexts = new Map<string, tls.SecureContext>();
  private fingerprints = new Map<string, string>();
  private fallback: tls.SecureContext;
  private decrypt: (s: string) => string;
  private log: (m: string) => void;
  private appsDomain: string | null;
  private platformFile: tls.SecureContext | null = null;

  constructor(defaultCert: { cert: string; key: string }, decrypt: (s: string) => string, log: (m: string) => void = (m) => console.error(m), opts: { appsDomain?: string } = {}) {
    this.fallback = tls.createSecureContext({ cert: defaultCert.cert, key: defaultCert.key, minVersion: 'TLSv1.2' });
    this.decrypt = decrypt;
    this.log = log;
    this.appsDomain = opts.appsDomain?.toLowerCase().replace(/\.$/, '') || null;
  }

  get size(): number { return this.contexts.size; }

  /** Operator-supplied wildcard (NAV_WILDCARD_CERT_FILE / NAV_WILDCARD_KEY_FILE); null clears it. Throws if invalid. */
  setPlatformFiles(pem: { cert: string; key: string } | null): void {
    this.platformFile = pem ? tls.createSecureContext({ cert: pem.cert, key: pem.key, minVersion: 'TLSv1.2' }) : null;
  }

  /** Where the apps-domain certificate comes from; null means the development fallback. */
  platformSource(): 'files' | 'acme' | null {
    if (this.platformFile) return 'files';
    return this.appsDomain && this.contexts.has(`*.${this.appsDomain}`) ? 'acme' : null;
  }

  private platform(name: string): tls.SecureContext | null {
    const d = this.appsDomain;
    if (!d) return null;
    const under = name.endsWith(`.${d}`) && !name.slice(0, -d.length - 1).includes('.') && name.length > d.length + 1;
    if (name !== d && !under) return null;
    return this.platformFile ?? this.contexts.get(`*.${d}`) ?? null;
  }

  setRows(rows: CertRow[]): void {
    const next = new Map<string, tls.SecureContext>();
    const nextFp = new Map<string, string>();
    for (const r of rows) {
      const domain = String(r.domain).toLowerCase();
      const fp = `${r.cert_pem.length}:${r.cert_pem.slice(-64)}:${r.key_enc.slice(-24)}`;
      const existing = this.contexts.get(domain);
      if (existing && this.fingerprints.get(domain) === fp) {
        next.set(domain, existing);
        nextFp.set(domain, fp);
        continue;
      }
      try {
        const ctx = tls.createSecureContext({ cert: r.cert_pem, key: this.decrypt(r.key_enc), minVersion: 'TLSv1.2' });
        next.set(domain, ctx);
        nextFp.set(domain, fp);
      } catch (err) {
        this.log(`[edge] skipping certificate for ${domain}: ${(err as Error).message}`);
        if (existing) { next.set(domain, existing); nextFp.set(domain, this.fingerprints.get(domain)!); }
      }
    }
    this.contexts = next;
    this.fingerprints = nextFp;
  }

  /** Context for an exact domain or its one-label wildcard; null when only the default applies. */
  find(servername: string): tls.SecureContext | null {
    const name = servername.toLowerCase().replace(/\.$/, '');
    const exact = this.contexts.get(name);
    if (exact) return exact;
    const platform = this.platform(name);
    if (platform) return platform;
    const dot = name.indexOf('.');
    if (dot > 0) {
      const wild = this.contexts.get(`*.${name.slice(dot + 1)}`);
      if (wild) return wild;
    }
    return null;
  }

  hasCert(host: string): boolean { return this.find(host) !== null; }

  sniCallback = (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void => {
    try {
      cb(null, this.find(servername) ?? this.fallback);
    } catch (err) {
      cb(err as Error);
    }
  };
}

export function certLoader(pool: pg.Pool, store: CertStore): () => Promise<void> {
  return async () => {
    const { rows } = await pool.query<CertRow>('SELECT domain, cert_pem, key_enc FROM certificates WHERE not_after > now()');
    store.setRows(rows);
  };
}

/**
 * Loads the operator's wildcard PEM files (manual mode) and reloads them when their size or mtime changes. Runs
 * with the other loaders, so changes are picked up on the next poll (every 10s) or nav_routes notification.
 * A missing or invalid file keeps the last good certificate.
 */
export function wildcardFileLoader(store: CertStore, certFile: string, keyFile: string, log: (m: string) => void = (m) => console.error(m)): () => Promise<void> {
  let seen = '';
  let lastError = '';
  return async () => {
    let stamp: string;
    try {
      const [c, k] = await Promise.all([fs.promises.stat(certFile), fs.promises.stat(keyFile)]);
      stamp = `${c.size}:${c.mtimeMs}:${k.size}:${k.mtimeMs}`;
    } catch (err) {
      const msg = `[edge] wildcard certificate files unreadable (${(err as Error).message}); ${store.platformSource() === 'files' ? 'keeping the last loaded certificate' : 'not loaded'}`;
      if (msg !== lastError) log(msg);
      lastError = msg;
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const [cert, key] = await Promise.all([fs.promises.readFile(certFile, 'utf8'), fs.promises.readFile(keyFile, 'utf8')]);
      const x = new X509Certificate(cert);
      store.setPlatformFiles({ cert, key });
      lastError = '';
      log(`[edge] loaded wildcard certificate ${certFile} (${x.subjectAltName ?? x.subject}, expires ${new Date(x.validTo).toISOString()})`);
    } catch (err) {
      lastError = `[edge] invalid wildcard certificate files ${certFile} / ${keyFile}: ${(err as Error).message}; keeping the previous certificate`;
      log(lastError);
    }
  };
}

/** Logs whenever the apps-domain certificate source changes; warns in production when only the dev certificate is left. */
export function platformCertMonitor(store: CertStore, appsDomain: string, production: boolean, log: (m: string) => void = (m) => console.error(m)): () => Promise<void> {
  let last: string | undefined;
  return async () => {
    const src = store.platformSource() ?? 'dev';
    if (src === last) return;
    last = src;
    if (src === 'files') log(`[edge] *.${appsDomain}: serving the operator-supplied wildcard certificate`);
    else if (src === 'acme') log(`[edge] *.${appsDomain}: serving the ACME wildcard certificate`);
    else if (production) log(`[edge] WARNING: no wildcard certificate for *.${appsDomain}; falling back to the self-signed development certificate (browsers will warn). Configure NAV_DNS_PROVIDER (see Self-hosting > Platform domain & TLS).`);
  };
}
