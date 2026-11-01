// DNS providers for ACME DNS-01 challenges, plus a propagation check against the authoritative nameservers.
// A provider only needs to create and remove TXT records; add Route53, DigitalOcean... by implementing DnsProvider.
import { Resolver } from 'node:dns/promises';

export interface DnsProvider {
  readonly name: string;
  /** Adds a TXT record (other values on the same name must be kept). Returns a handle for removeTxt. */
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
