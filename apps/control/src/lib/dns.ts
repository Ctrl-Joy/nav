// DNS providers for ACME DNS-01 challenges, plus a propagation check against the authoritative nameservers.
// A provider only needs to create and remove TXT records; add Route53, DigitalOcean... by implementing DnsProvider.
import { Resolver } from 'node:dns/promises';

export interface DnsProvider {
  readonly name: string;
  /**
   * The provider holds only one TXT value per name (DuckDNS): createTxt replaces the previous value. ACME
   * authorizations are then validated one at a time, and the platform order skips the apex identifier.
   */
  readonly singleTxt?: boolean;
  /** Adds a TXT record (other values on the same name must be kept, unless singleTxt). Returns a handle for removeTxt. */
  createTxt(fqdn: string, value: string): Promise<string>;
  removeTxt(handle: string): Promise<void>;
}

// --- Cloudflare ----------------------------------------------------------------------------------

export interface CloudflareOptions {
  /** API token scoped to Zone:DNS:Edit for the zone. */
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

interface CfResponse<T> { success: boolean; errors?: Array<{ code: number; message: string }>; result: T }

export function cloudflareProvider(opts: CloudflareOptions): DnsProvider {
  const base = (opts.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const zones = new Map<string, string | null>();

  async function api<T>(method: string, p: string, body?: unknown): Promise<CfResponse<T>> {
    const res = await doFetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => null)) as CfResponse<T> | null;
    if (!json) throw new Error(`Cloudflare API ${method} ${p}: HTTP ${res.status}`);
    return json;
  }
  const failure = (what: string, r: CfResponse<unknown>) =>
    new Error(`Cloudflare ${what} failed: ${(r.errors ?? []).map((e) => `${e.message} (${e.code})`).join('; ') || 'unknown error'}`);

  /** Finds the zone by walking up the labels: _acme-challenge.apps.example.com → apps.example.com → example.com. */
  async function zoneFor(fqdn: string): Promise<string> {
    const labels = fqdn.toLowerCase().replace(/\.$/, '').split('.');
    for (let i = 0; i <= labels.length - 2; i++) {
      const candidate = labels.slice(i).join('.');
      if (!zones.has(candidate)) {
        const r = await api<Array<{ id: string; name: string }>>('GET', `/zones?name=${encodeURIComponent(candidate)}&per_page=5`);
        if (!r.success) throw failure(`zone lookup for ${candidate}`, r);
        zones.set(candidate, r.result.find((z) => z.name === candidate)?.id ?? null);
      }
      const id = zones.get(candidate);
      if (id) return id;
    }
    throw new Error(`no Cloudflare zone found for ${fqdn} — is the token scoped to that zone?`);
  }

  return {
    name: 'cloudflare',
    async createTxt(fqdn, value) {
      const zone = await zoneFor(fqdn);
      const r = await api<{ id: string }>('POST', `/zones/${zone}/dns_records`, { type: 'TXT', name: fqdn, content: `"${value}"`, ttl: 60, comment: 'NAV ACME DNS-01 challenge' });
      if (r.success) return `${zone}/${r.result.id}`;
      // A leftover identical record (e.g. from an interrupted run): adopt it so it is removed afterwards.
      if (r.errors?.some((e) => e.code === 81058 || e.code === 81057)) {
        const list = await api<Array<{ id: string; content: string }>>('GET', `/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}`);
        const hit = list.success ? list.result.find((x) => x.content.replace(/^"|"$/g, '') === value) : undefined;
        if (hit) return `${zone}/${hit.id}`;
      }
      throw failure(`creating TXT ${fqdn}`, r);
    },
    async removeTxt(handle) {
      const [zone, record] = handle.split('/');
      const r = await api<unknown>('DELETE', `/zones/${zone}/dns_records/${record}`);
      if (!r.success && !r.errors?.some((e) => e.code === 81044)) throw failure('deleting TXT record', r); // 81044: already gone
    },
  };
}

// --- DuckDNS -------------------------------------------------------------------------------------

export interface DuckDnsOptions {
  /** The account token shown on duckdns.org. */
  token: string;
  /** NAV_APPS_DOMAIN: `<sub>.duckdns.org` or a name below it. */
  domain: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

const DUCKDNS_SUFFIX = '.duckdns.org';

/**
 * The DuckDNS subdomain that owns `name`: the first label below duckdns.org
 * (`onnav.duckdns.org`, `_acme-challenge.onnav.duckdns.org` and `x.onnav.duckdns.org` all give `onnav`).
 */
export function duckdnsSubdomain(name: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (!n.endsWith(DUCKDNS_SUFFIX)) throw new Error(`${name} is not a duckdns.org name (NAV_DNS_PROVIDER=duckdns needs NAV_APPS_DOMAIN=<sub>.duckdns.org)`);
  const sub = n.slice(0, -DUCKDNS_SUFFIX.length).split('.').pop() ?? '';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub)) throw new Error(`${name} has no valid DuckDNS subdomain label below duckdns.org`);
  return sub;
}

/**
 * DuckDNS keeps one TXT value per subdomain and serves it for every name below it, including
 * `_acme-challenge.<sub>.duckdns.org`. `update?txt=` replaces the value, `clear=true` removes it; the API answers
 * `OK` or `KO` (bad token, or a subdomain the account does not own) as plain text.
 */
export function duckdnsProvider(opts: DuckDnsOptions): DnsProvider {
  const base = (opts.apiBase ?? 'https://www.duckdns.org').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const sub = duckdnsSubdomain(opts.domain);

  async function update(params: Record<string, string>): Promise<string[]> {
    const qs = new URLSearchParams({ domains: sub, token: opts.token, ...params, verbose: 'true' });
    // The URL carries the token: never put it in an error message.
    const what = params.clear ? 'clearing the TXT record' : 'setting the TXT record';
    let res: Response;
    try {
      res = await doFetch(`${base}/update?${qs}`, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new Error(`DuckDNS ${what} of ${sub}.duckdns.org failed: ${(err as Error & { cause?: Error }).cause?.message ?? (err as Error).message}`);
    }
    const lines = (await res.text().catch(() => '')).split(/\r?\n/).map((l) => l.trim());
    if (!res.ok) throw new Error(`DuckDNS ${what} of ${sub}.duckdns.org failed: HTTP ${res.status}`);
    if (lines[0] !== 'OK') {
      throw new Error(`DuckDNS ${what} of ${sub}.duckdns.org was refused (${lines[0] || 'empty response'}): check NAV_DUCKDNS_TOKEN and that ${sub} belongs to that account`);
    }
    return lines;
  }

  return {
    name: 'duckdns',
    singleTxt: true,
    async createTxt(fqdn, value) {
      const owner = duckdnsSubdomain(fqdn);
      if (owner !== sub) throw new Error(`DuckDNS provider is configured for ${sub}.duckdns.org, not ${fqdn}`);
      await update({ txt: value });
      return sub;
    },
    async removeTxt(handle) {
      if (handle !== sub) throw new Error(`unknown DuckDNS record handle ${handle}`);
      await update({ txt: '', clear: 'true' });
    },
  };
}

// --- Propagation -----------------------------------------------------------------------------------

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export interface PropagationOptions {
  /** Nameserver IPs to check. Default: the name's authoritative servers (found via 1.1.1.1), else 1.1.1.1 + 8.8.8.8. */
  servers?: string[];
  timeoutMs?: number;
  intervalMs?: number;
  resolverFor?: (server: string) => TxtResolver;
  log?: (m: string) => void;
}

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

function udpResolver(server: string): Resolver {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  r.setServers([server]);
  return r;
}

/** IPv4 addresses of the authoritative nameservers for `fqdn`'s zone (walking up the labels), or [] if unknown. */
export async function authoritativeServers(fqdn: string, resolver: Resolver = udpResolver(PUBLIC_RESOLVERS[0])): Promise<string[]> {
  const labels = fqdn.replace(/\.$/, '').split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const ns = await resolver.resolveNs(labels.slice(i).join('.')).catch(() => [] as string[]);
    if (!ns.length) continue;
    const ips = (await Promise.all(ns.map((n) => resolver.resolve4(n).catch(() => [] as string[])))).flat();
    return [...new Set(ips)];
  }
  return [];
}

/** Waits until every server returns all `values` for the TXT record `fqdn`. Throws after the timeout. */
export async function waitForTxt(fqdn: string, values: string[], opts: PropagationOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const resolverFor = opts.resolverFor ?? udpResolver;
  let servers = opts.servers;
  if (!servers?.length) {
    servers = await authoritativeServers(fqdn);
    if (!servers.length) servers = PUBLIC_RESOLVERS;
  }
  const resolvers = servers.map((s) => ({ server: s, r: resolverFor(s) }));
  const deadline = Date.now() + timeoutMs;
  let missing: string[] = [];
  for (;;) {
    missing = [];
    for (const { server, r } of resolvers) {
      const records = await r.resolveTxt(fqdn).catch(() => [] as string[][]);
      const seen = new Set(records.map((chunks) => chunks.join('')));
      if (!values.every((v) => seen.has(v))) missing.push(server);
    }
    if (!missing.length) return;
    if (Date.now() + intervalMs > deadline) break;
    opts.log?.(`waiting for TXT ${fqdn} on ${missing.join(', ')}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`TXT record ${fqdn} not visible on ${missing.join(', ')} after ${Math.round(timeoutMs / 1000)}s`);
}
