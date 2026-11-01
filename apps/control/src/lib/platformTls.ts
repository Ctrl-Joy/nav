// Platform TLS: one wildcard certificate for `*.<appsDomain>` + `<appsDomain>` so every service URL gets a trusted
// certificate (only `*.<appsDomain>` with a provider that holds a single TXT value, such as DuckDNS). Issued with ACME DNS-01 through a DnsProvider (lib/dns.ts) by a control-plane job, stored in
// `certificates` under '*.<appsDomain>' (the edge serves it by SNI) and renewed 30 days before expiry. With
// NAV_DNS_PROVIDER=manual the operator supplies PEM files instead, which the edge loads and hot-reloads.
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Authorization, Client } from 'acme-client';
import { config } from '@nav/shared/config';
import { encrypt } from '@nav/shared/crypto';
import { notify, one, q } from '../db/pool.ts';
import { enqueue } from './core.ts';
import { cloudflareProvider, duckdnsProvider, waitForTxt, type DnsProvider } from './dns.ts';
import { acmeClient, isLocalDomain } from './domains.ts';

export const PLATFORM_CERT_JOB = 'issue_platform_cert';
const RENEW_DAYS = 30;
/** After a failed issuance, wait this long before trying again automatically (Let's Encrypt rate limits). */
const RETRY_AFTER_HOURS = 6;

const log = (m: string) => console.log(`[tls] ${m}`);
export const platformCertDomain = (appsDomain = config.appsDomain) => `*.${appsDomain}`;
/** Names on the platform certificate. A single-TXT provider skips the apex (see orderWildcard). */
export const platformCertNames = (appsDomain: string, provider?: Pick<DnsProvider, 'singleTxt'> | null, includeApex = !provider?.singleTxt) =>
  includeApex ? [platformCertDomain(appsDomain), appsDomain] : [platformCertDomain(appsDomain)];
const isStaging = () => /staging/i.test(config.acmeDirectory);

export type PlatformTlsMode = 'dns-01' | 'manual' | 'none';

export function platformTlsMode(): PlatformTlsMode {
  const p = config.platformTls.dnsProvider;
  if (p === 'manual') return 'manual';
  return p ? 'dns-01' : 'none';
}

/** The configured DNS provider; null when none / manual. Throws on a misconfiguration. */
export function dnsProviderFromConfig(): DnsProvider | null {
  const p = config.platformTls.dnsProvider;
  switch (p) {
    case '':
    case 'manual':
      return null;
    case 'cloudflare':
      if (!config.platformTls.cloudflareApiToken) throw new Error('NAV_DNS_PROVIDER=cloudflare requires NAV_CLOUDFLARE_API_TOKEN');
      return cloudflareProvider({ token: config.platformTls.cloudflareApiToken });
    case 'duckdns':
      if (!config.platformTls.duckdnsToken) throw new Error('NAV_DNS_PROVIDER=duckdns requires NAV_DUCKDNS_TOKEN');
      return duckdnsProvider({ token: config.platformTls.duckdnsToken, domain: config.appsDomain });
    default:
      throw new Error(`unknown NAV_DNS_PROVIDER "${p}" (supported: cloudflare, duckdns, manual)`);
  }
}

export type AcmeOrderClient = Pick<Client, 'createAccount' | 'createOrder' | 'getAuthorizations' | 'getChallengeKeyAuthorization' | 'completeChallenge' | 'waitForValidStatus' | 'finalizeOrder' | 'getCertificate'>;

export interface WildcardOrder {
  appsDomain: string;
  client: AcmeOrderClient;
  provider: DnsProvider;
  email?: string;
  /** Propagation check; defaults to waitForTxt against the authoritative nameservers. */
  waitFor?: (fqdn: string, values: string[]) => Promise<void>;
  /** Also order `<appsDomain>`. Default: true, except for single-TXT providers. */
  includeApex?: boolean;
  log?: (m: string) => void;
}

/**
 * Orders `*.<d>` + `<d>`. Both authorizations use `_acme-challenge.<d>`, so both TXT values are published
 * together, checked for propagation, then validated. The records are always removed afterwards.
 *
 * A single-TXT provider (DuckDNS) cannot publish both values at once, so its authorizations are validated one at a
 * time: publish, wait for propagation, validate, remove, next. By default it orders only `*.<d>`: validating the apex
 * right after the wildcard would need the CA to see a changed TXT value within the record's TTL, which resolver
 * caching makes unreliable. Services use `<slug>.<d>`, so the apex is not needed.
 */
export async function orderWildcard(o: WildcardOrder): Promise<{ certPem: string; keyPem: string; issuer: string; notAfter: Date }> {
  const acme = (await import('acme-client')).default;
  const say = o.log ?? (() => {});
  const waitFor = o.waitFor ?? ((fqdn, values) => waitForTxt(fqdn, values, { log: say }));
  const names = platformCertNames(o.appsDomain, o.provider, o.includeApex);
  await o.client.createAccount({ termsOfServiceAgreed: true, ...(o.email ? { contact: [`mailto:${o.email}`] } : {}) });
  const order = await o.client.createOrder({ identifiers: names.map((value) => ({ type: 'dns', value })) });
  const authzs: Authorization[] = await o.client.getAuthorizations(order);
  const pending: PendingChallenge[] = [];
  for (const authz of authzs) {
    if (authz.status === 'valid') continue; // reused authorization
    const challenge = authz.challenges.find((c) => c.type === 'dns-01');
    if (!challenge) throw new Error(`no dns-01 challenge offered for ${authz.identifier.value}`);
    pending.push({ fqdn: `_acme-challenge.${authz.identifier.value}`, value: await o.client.getChallengeKeyAuthorization(challenge), challenge });
  }
  if (o.provider.singleTxt) {
    for (const p of pending) {
      say(`setting TXT ${p.fqdn} via ${o.provider.name} (one authorization at a time)`);
      let handle: string | null = null;
      try {
        handle = await o.provider.createTxt(p.fqdn, p.value);
        await waitFor(p.fqdn, [p.value]);
        await o.client.completeChallenge(p.challenge);
        await o.client.waitForValidStatus(p.challenge);
      } finally {
        if (handle !== null) await o.provider.removeTxt(handle).catch((err) => say(`could not remove TXT record ${handle}: ${(err as Error).message}`));
      }
    }
  } else {
    await validateTogether(o, pending, waitFor, say);
  }
  const [key, csr] = await acme.crypto.createCsr({ commonName: names[0], altNames: names });
  const finalized = await o.client.finalizeOrder(order, csr);
  const certPem = await o.client.getCertificate(finalized);
  const info = acme.crypto.readCertificateInfo(certPem);
  return { certPem, keyPem: key.toString(), issuer: info.issuer.commonName ?? 'ACME', notAfter: info.notAfter };
}

type PendingChallenge = { fqdn: string; value: string; challenge: Authorization['challenges'][number] };

/** Publishes every TXT value, waits for all of them, then validates each authorization. */
async function validateTogether(o: WildcardOrder, pending: PendingChallenge[], waitFor: (fqdn: string, values: string[]) => Promise<void>, say: (m: string) => void): Promise<void> {
  const handles: string[] = [];
  try {
    for (const p of pending) {
      say(`creating TXT ${p.fqdn} via ${o.provider.name}`);
      handles.push(await o.provider.createTxt(p.fqdn, p.value));
    }
    for (const fqdn of new Set(pending.map((p) => p.fqdn))) await waitFor(fqdn, pending.filter((p) => p.fqdn === fqdn).map((p) => p.value));
    for (const p of pending) {
      await o.client.completeChallenge(p.challenge);
      await o.client.waitForValidStatus(p.challenge);
    }
  } finally {
    for (const h of handles) await o.provider.removeTxt(h).catch((err) => say(`could not remove TXT record ${h}: ${(err as Error).message}`));
  }
}

async function setStatus(status: string, fields: { lastError?: string | null; issued?: boolean } = {}): Promise<void> {
  await q(
    `INSERT INTO platform_tls (domain, provider, status, last_error, last_attempt_at, issued_at, acme_directory)
     VALUES ($1,$2,$3,$4,now(),CASE WHEN $5::boolean THEN now() END,CASE WHEN $5::boolean THEN $6::text END)
     ON CONFLICT (domain) DO UPDATE SET provider = EXCLUDED.provider, status = EXCLUDED.status, last_error = EXCLUDED.last_error,
       last_attempt_at = now(), issued_at = COALESCE(EXCLUDED.issued_at, platform_tls.issued_at),
       acme_directory = COALESCE(EXCLUDED.acme_directory, platform_tls.acme_directory), updated_at = now()`,
    [config.appsDomain, config.platformTls.dnsProvider || 'none', status, fields.lastError ?? null, fields.issued ?? false, config.acmeDirectory],
  );
}

/** Control-plane job: issue (or renew) the platform wildcard certificate. */
export async function issuePlatformCertificate(say: (m: string) => void = log): Promise<void> {
  const provider = dnsProviderFromConfig();
  if (!provider) return;
  await setStatus('issuing');
  try {
    say(`requesting ${platformCertNames(config.appsDomain, provider).join(' + ')} from ${config.acmeDirectory} (DNS-01 via ${provider.name})`);
    // acme-client reports network failures as a TypeError; check reachability first for a readable error.
    await fetch(config.acmeDirectory, { signal: AbortSignal.timeout(15_000) }).then(
      (r) => { if (!r.ok) throw new Error(`ACME directory ${config.acmeDirectory} returned HTTP ${r.status}`); },
      (err) => { throw new Error(`cannot reach ACME directory ${config.acmeDirectory}: ${(err as Error & { cause?: Error }).cause?.message ?? (err as Error).message}`); },
    );
    const cert = await orderWildcard({ appsDomain: config.appsDomain, client: await acmeClient(), provider, email: config.acmeEmail, log: say });
    await q(
      `INSERT INTO certificates (domain, cert_pem, key_enc, issuer, not_after) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (domain) DO UPDATE SET cert_pem = EXCLUDED.cert_pem, key_enc = EXCLUDED.key_enc, issuer = EXCLUDED.issuer, not_after = EXCLUDED.not_after, created_at = now()`,
      [platformCertDomain(), cert.certPem, encrypt(cert.keyPem), cert.issuer, cert.notAfter],
    );
    await setStatus('issued', { issued: true });
    await notify('nav_routes');
    say(`issued wildcard certificate for *.${config.appsDomain} by ${cert.issuer}, valid until ${cert.notAfter.toISOString()}${isStaging() ? ' (Let\'s Encrypt STAGING: browsers will not trust it; set NAV_ACME_DIRECTORY to production once this works)' : ''}`);
  } catch (err) {
    await setStatus('failed', { lastError: (err as Error).message.slice(0, 1000) });
    throw err;
  }
}

/**
 * Called on startup and by the scheduler: enqueues issuance when the wildcard is missing or expires within 30
 * days, and logs clearly when production has no trusted certificate for the apps domain.
 */
export async function ensurePlatformCertificate(opts: { force?: boolean } = {}): Promise<'enqueued' | 'ok' | 'skipped'> {
  const mode = platformTlsMode();
  const production = config.env === 'production';
  if (isLocalDomain(config.appsDomain)) return 'skipped';
  if (mode === 'manual') {
    if (!config.platformTls.certFile || !config.platformTls.keyFile) log('NAV_DNS_PROVIDER=manual but NAV_WILDCARD_CERT_FILE / NAV_WILDCARD_KEY_FILE are not set: the edge falls back to its self-signed development certificate');
    return 'skipped';
  }
  const row = await one<{ not_after: Date }>('SELECT not_after FROM certificates WHERE domain = $1', [platformCertDomain()]);
  const daysLeft = row ? (new Date(row.not_after).getTime() - Date.now()) / 86400_000 : -1;
  if (mode === 'none') {
    if (production && daysLeft <= 0) log(`WARNING: no certificate for *.${config.appsDomain}; the edge serves its self-signed development certificate and browsers will warn. Set NAV_DNS_PROVIDER=cloudflare + NAV_CLOUDFLARE_API_TOKEN, NAV_DNS_PROVIDER=duckdns + NAV_DUCKDNS_TOKEN (or NAV_DNS_PROVIDER=manual with NAV_WILDCARD_CERT_FILE / NAV_WILDCARD_KEY_FILE).`);
    return 'skipped';
  }
  if (!config.platformTls.enabled && !opts.force) {
    if (production) log('NAV_PLATFORM_TLS=0: automatic wildcard certificate issuance is disabled');
    return 'skipped';
  }
  dnsProviderFromConfig(); // surface misconfiguration (missing token, unknown provider) in the log
  const st = await one<{ acme_directory: string | null }>('SELECT acme_directory FROM platform_tls WHERE domain = $1', [config.appsDomain]);
  const directoryChanged = daysLeft > 0 && !!st?.acme_directory && st.acme_directory !== config.acmeDirectory;
  if (!opts.force && daysLeft > RENEW_DAYS && !directoryChanged) return 'ok';
  const active = await one("SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued','running')", [PLATFORM_CERT_JOB]);
  if (active) return 'enqueued';
  if (!opts.force) {
    const recent = await one(`SELECT 1 FROM platform_tls WHERE domain = $1 AND status = 'failed' AND last_attempt_at > now() - make_interval(hours => $2)`, [config.appsDomain, RETRY_AFTER_HOURS]);
    if (recent) {
      if (daysLeft <= 0) log(`no certificate for *.${config.appsDomain} yet (last attempt failed; retrying within ${RETRY_AFTER_HOURS}h) — falling back to the development certificate`);
      return 'skipped';
    }
  }
  log(directoryChanged ? `NAV_ACME_DIRECTORY changed since *.${config.appsDomain} was issued: re-issuing from ${config.acmeDirectory}` : daysLeft > 0 ? `wildcard certificate for *.${config.appsDomain} expires in ${Math.floor(daysLeft)} days: renewing` : `no wildcard certificate for *.${config.appsDomain}: issuing (falling back to the development certificate until then)`);
  await enqueue(PLATFORM_CERT_JOB, {}, { maxAttempts: 2 });
  return 'enqueued';
}

/** Admin view of the platform certificate. */
export async function platformTlsStatus() {
  const mode = platformTlsMode();
  let provider: DnsProvider | null = null;
  try { provider = dnsProviderFromConfig(); } catch { /* a misconfiguration shows up in lastError and the log */ }
  const base = {
    domain: config.appsDomain,
    names: platformCertNames(config.appsDomain, provider),
    mode,
    provider: config.platformTls.dnsProvider || null,
    enabled: mode === 'manual' || (mode === 'dns-01' && config.platformTls.enabled),
    acmeDirectory: config.acmeDirectory,
    staging: isStaging(),
  };
  if (mode === 'manual') {
    const files = { certFile: config.platformTls.certFile || null, keyFile: config.platformTls.keyFile || null };
    try {
      const x = new X509Certificate(await readFile(config.platformTls.certFile));
      return { ...base, ...files, status: 'issued', issuer: x.issuer.match(/CN=([^\n]+)/)?.[1] ?? x.issuer, notAfter: new Date(x.validTo).toISOString(), lastError: null, lastAttemptAt: null };
    } catch (err) {
      return { ...base, ...files, status: 'failed', issuer: null, notAfter: null, lastError: `cannot read ${config.platformTls.certFile || 'NAV_WILDCARD_CERT_FILE'}: ${(err as Error).message}`, lastAttemptAt: null };
    }
  }
  const cert = await one('SELECT issuer, not_after, created_at FROM certificates WHERE domain = $1', [platformCertDomain()]);
  const st = await one('SELECT * FROM platform_tls WHERE domain = $1', [config.appsDomain]);
  const job = await one("SELECT status FROM jobs WHERE kind = $1 AND status IN ('queued','running') LIMIT 1", [PLATFORM_CERT_JOB]);
  return {
    ...base,
    status: job ? 'issuing' : cert && new Date(cert.not_after) > new Date() ? 'issued' : st?.status === 'failed' ? 'failed' : 'missing',
    issuer: cert?.issuer ?? null,
    notAfter: cert ? new Date(cert.not_after).toISOString() : null,
    issuedAt: cert ? new Date(cert.created_at).toISOString() : null,
    issuedFromDirectory: st?.acme_directory ?? null,
    lastError: st?.last_error ?? null,
    lastAttemptAt: st?.last_attempt_at ? new Date(st.last_attempt_at).toISOString() : null,
  };
}
