// Custom domain verification (DNS) and TLS certificate issuance (ACME HTTP-01, or a local CA in development).
import { resolve4, resolveCname } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '@nav/shared/config';
import { encrypt } from '@nav/shared/crypto';
import { notify, one, q } from '../db/pool.ts';
import { changed, enqueue, recordEvent } from './core.ts';

const LOCAL_TLDS = ['.localhost', '.test', '.local'];
export const isLocalDomain = (d: string) => LOCAL_TLDS.some((t) => d.endsWith(t));

export async function verifyDomain(domainId: string): Promise<void> {
  const d = await one('SELECT d.*, s.slug, s.workspace_id FROM custom_domains d JOIN services s ON s.id = d.service_id WHERE d.id = $1', [domainId]);
  if (!d) return;
  const host = d.domain.startsWith('*.') ? `nav-verify-${Date.now().toString(36)}.${d.domain.slice(2)}` : d.domain;
  const target = `${d.slug}.${config.appsDomain}`;
  let ok = false;
  let reason = '';
  if (isLocalDomain(d.domain)) {
    ok = true;
  } else {
    const cname = await resolveCname(host).catch(() => [] as string[]);
    if (cname.some((c) => c.replace(/\.$/, '').toLowerCase() === target)) ok = true;
    else {
      const a = await resolve4(host).catch(() => [] as string[]);
      const targetA = await resolve4(target).catch(() => [config.edgePublicIp]);
      if (a.length && a.every((ip) => targetA.includes(ip) || ip === config.edgePublicIp)) ok = true;
      else reason = cname.length ? `CNAME points to ${cname.join(', ')}, expected ${target}` : a.length ? `A record points to ${a.join(', ')}, expected ${config.edgePublicIp}` : 'no DNS record found yet';
    }
  }
  if (ok) {
    await q("UPDATE custom_domains SET verification_status = 'verified', verified_at = COALESCE(verified_at, now()), last_error = NULL, cert_status = CASE WHEN cert_status = 'issued' THEN 'issued' ELSE 'issuing' END WHERE id = $1", [d.id]);
    await notify('nav_routes');
    if (d.cert_status !== 'issued') await enqueue('issue_cert', { domainId: d.id }, { maxAttempts: 3 });
    if (d.verification_status !== 'verified') await recordEvent({ workspaceId: d.workspace_id, serviceId: d.service_id, kind: 'domain_verified', data: { domain: d.domain } });
  } else {
    await q("UPDATE custom_domains SET verification_status = 'unverified', last_error = $2 WHERE id = $1", [d.id, reason]);
  }
  await changed(d.workspace_id, 'domain', d.id, d.service_id);
}

/** Issues a certificate for a verified domain and stores it (key encrypted) for the edge. */
export async function issueCertificate(domainId: string, log: (m: string) => void = () => {}): Promise<void> {
  const d = await one('SELECT d.*, s.workspace_id FROM custom_domains d JOIN services s ON s.id = d.service_id WHERE d.id = $1', [domainId]);
  if (!d || d.verification_status !== 'verified') return;
  try {
    const useAcme = !isLocalDomain(d.domain) && config.acmeEmail;
    const { certPem, keyPem, issuer, notAfter } = useAcme ? await acmeIssue(d.domain, log) : await localIssue(d.domain);
    await q(
      `INSERT INTO certificates (domain, cert_pem, key_enc, issuer, not_after) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (domain) DO UPDATE SET cert_pem = EXCLUDED.cert_pem, key_enc = EXCLUDED.key_enc, issuer = EXCLUDED.issuer, not_after = EXCLUDED.not_after, created_at = now()`,
      [d.domain, certPem, encrypt(keyPem), issuer, notAfter],
    );
    await q("UPDATE custom_domains SET cert_status = 'issued', last_error = NULL WHERE id = $1", [d.id]);
    await notify('nav_routes');
    await recordEvent({ workspaceId: d.workspace_id, serviceId: d.service_id, kind: 'certificate_issued', data: { domain: d.domain, issuer } });
  } catch (err) {
    await q("UPDATE custom_domains SET cert_status = 'failed', last_error = $2 WHERE id = $1", [d.id, (err as Error).message.slice(0, 500)]);
    throw err;
  } finally {
    await changed(d.workspace_id, 'domain', d.id, d.service_id);
  }
}

/** ACME client for config.acmeDirectory with the installation's account key (created on first use). */
export async function acmeClient() {
  const acme = (await import('acme-client')).default;
  const accountKeyPath = path.join(config.dataDir, 'acme-account.pem');
  const { mkdir, writeFile } = await import('node:fs/promises');
  let accountKey: Buffer;
  if (existsSync(accountKeyPath)) accountKey = await readFile(accountKeyPath);
  else {
    accountKey = await acme.crypto.createPrivateKey();
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(accountKeyPath, accountKey, { mode: 0o600 });
  }
  return new acme.Client({ directoryUrl: config.acmeDirectory, accountKey });
}

async function acmeIssue(domain: string, log: (m: string) => void) {
  if (domain.startsWith('*.')) throw new Error('wildcard certificates require a DNS-01 challenge, which is not configured on this NAV installation');
  const acme = (await import('acme-client')).default;
  const client = await acmeClient();
  const [key, csr] = await acme.crypto.createCsr({ altNames: [domain] });
  log(`requesting certificate for ${domain} from ${config.acmeDirectory}`);
  const cert = await client.auto({
    csr,
    email: config.acmeEmail,
    termsOfServiceAgreed: true,
    challengePriority: ['http-01'],
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      await q('INSERT INTO acme_challenges (token, key_auth) VALUES ($1,$2) ON CONFLICT (token) DO UPDATE SET key_auth = EXCLUDED.key_auth', [challenge.token, keyAuthorization]);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      await q('DELETE FROM acme_challenges WHERE token = $1', [challenge.token]);
    },
  });
  const info = acme.crypto.readCertificateInfo(cert);
  return { certPem: cert, keyPem: key.toString(), issuer: info.issuer.commonName ?? 'ACME', notAfter: info.notAfter };
}

/** Development: sign with the edge's local CA (created by apps/edge under <dataDir>/edge). */
async function localIssue(domain: string) {
  const forge = (await import('node-forge')).default;
  const dir = path.join(config.dataDir, 'edge');
  const caCertPem = await readFile(path.join(dir, 'ca.pem'), 'utf8').catch(() => null);
  const caKeyPem = await readFile(path.join(dir, 'ca-key.pem'), 'utf8').catch(() => null);
  if (!caCertPem || !caKeyPem) throw new Error('local CA not found — start the edge once so it can create it');
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 90 * 86400_000);
  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert) + caCertPem,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    issuer: 'NAV Local CA',
    notAfter: cert.validity.notAfter,
  };
}
