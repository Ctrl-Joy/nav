// In-memory routing table built from the `edge_routes` view, indexed by hostname.
// The table source is pluggable: DbRouteWatcher (LISTEN nav_routes + safety poll) in production,
// or RouteTable.setRows() directly in tests.
import type pg from 'pg';

export interface Upstream { id: string; host: string; port: number }
export interface DomainEntry { domain: string; redirectTo: string | null }
export interface StaticHeaderRule { path: string; name: string; value: string }
export interface StaticRouteRule { type: 'redirect' | 'rewrite'; source: string; destination: string }
export interface Artifact { kind: string; path?: string; ref?: string; [k: string]: unknown }

export interface Route {
  serviceId: string;
  slug: string;
  type: 'web' | 'static' | string;
  suspended: boolean;
  maintenanceMode: boolean;
  status: string;
  staticHeaders: StaticHeaderRule[];
  staticRoutes: StaticRouteRule[];
  artifact: Artifact | null;
  upstreams: Upstream[];
  domains: DomainEntry[];
}

/** Row shape of the `edge_routes` view (snake_case, json columns may arrive parsed or as text). */
export interface EdgeRouteRow {
  service_id: string;
  slug: string;
  type: string;
  suspended: boolean;
  maintenance_mode: boolean;
  status?: string;
  static_headers?: unknown;
  static_routes?: unknown;
  artifact?: unknown;
  upstreams?: unknown;
  domains?: unknown;
}

export interface HostMatch { route: Route; redirectTo: string | null; host: string }

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

export function normalizeRow(row: EdgeRouteRow): Route {
  const arr = <T>(v: unknown): T[] => { const x = json<unknown>(v, []); return Array.isArray(x) ? (x as T[]) : []; };
  return {
    serviceId: String(row.service_id),
    slug: String(row.slug).toLowerCase(),
    type: String(row.type),
    suspended: Boolean(row.suspended),
    maintenanceMode: Boolean(row.maintenance_mode),
    status: String(row.status ?? ''),
    staticHeaders: arr<StaticHeaderRule>(row.static_headers),
    staticRoutes: arr<StaticRouteRule>(row.static_routes),
    artifact: json<Artifact | null>(row.artifact, null),
    upstreams: arr<Upstream>(row.upstreams)
      .filter((u) => u && u.host && Number.isInteger(Number(u.port)))
      .map((u) => ({ id: String(u.id), host: String(u.host), port: Number(u.port) })),
    domains: arr<DomainEntry>(row.domains)
      .filter((d) => d && typeof d.domain === 'string')
      .map((d) => ({ domain: d.domain.toLowerCase().replace(/\.$/, ''), redirectTo: d.redirectTo ? String(d.redirectTo).toLowerCase() : null })),
  };
}

const HOST_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;

/** Lowercase, strip port and trailing dot, validate charset. Returns null for invalid hosts. */
export function sanitizeHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (h.length === 0 || h.length > 260) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    const rest = h.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    h = h.slice(0, end + 1);
    return IPV6_RE.test(h) ? h : null;
  }
  const colon = h.indexOf(':');
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(h.slice(colon + 1))) return null;
    h = h.slice(0, colon);
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  return HOST_RE.test(h) ? h : null;
}

export class RouteTable {
  readonly appsDomain: string;
  private exact = new Map<string, { route: Route; redirectTo: string | null }>();
  private wildcard = new Map<string, { route: Route; redirectTo: string | null }>();
  private routes: Route[] = [];
  loadedAt = 0;

  constructor(appsDomain: string) {
    this.appsDomain = appsDomain.toLowerCase();
  }

  get size(): number { return this.routes.length; }
  all(): readonly Route[] { return this.routes; }

  setRows(rows: EdgeRouteRow[]): void {
    this.setRoutes(rows.map(normalizeRow));
  }

  setRoutes(routes: Route[]): void {
    const exact = new Map<string, { route: Route; redirectTo: string | null }>();
    const wildcard = new Map<string, { route: Route; redirectTo: string | null }>();
    // Custom domains first so a platform hostname never shadows them (they can't collide anyway).
    for (const route of routes) {
      for (const d of route.domains) {
        if (d.domain.startsWith('*.')) wildcard.set(d.domain.slice(2), { route, redirectTo: d.redirectTo });
        else exact.set(d.domain, { route, redirectTo: d.redirectTo });
      }
    }
    for (const route of routes) {
      if (route.slug) exact.set(`${route.slug}.${this.appsDomain}`, { route, redirectTo: null });
    }
    this.exact = exact;
    this.wildcard = wildcard;
    this.routes = routes;
    this.loadedAt = Date.now();
  }

  /** `host` must already be sanitized. Wildcards match exactly one extra label. */
  lookup(host: string): HostMatch | null {
    const e = this.exact.get(host);
    if (e) return { ...e, host };
    const dot = host.indexOf('.');
    if (dot > 0) {
      const w = this.wildcard.get(host.slice(dot + 1));
      if (w) return { ...w, host };
    }
    return null;
  }
}

// --- Database-backed watcher --------------------------------------------------------------------

export interface WatcherOptions {
  pool: pg.Pool;
  /** Factory for the dedicated LISTEN connection. */
  createListener: () => pg.Client;
  /** Loaders run on every reload (routes, certificates...). Failures keep the previous state. */
  loaders: Array<() => Promise<void>>;
  debounceMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
}

export function routeLoader(pool: pg.Pool, table: RouteTable): () => Promise<void> {
  return async () => {
    const { rows } = await pool.query<EdgeRouteRow>('SELECT * FROM edge_routes');
    table.setRows(rows);
  };
}

export class DbRouteWatcher {
  private opts: Required<Omit<WatcherOptions, 'log'>> & { log: (m: string) => void };
  private listener: pg.Client | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = 500;
  private stopped = false;
  private reloading: Promise<void> | null = null;
  private again = false;

  constructor(opts: WatcherOptions) {
    this.opts = { debounceMs: 100, pollMs: 10_000, log: (m) => console.error(m), ...opts };
  }

  async start(): Promise<void> {
    await this.reloadNow();
    this.poll = setInterval(() => this.schedule(), this.opts.pollMs);
    this.poll.unref();
    void this.connect();
  }

  schedule(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.reloadNow(); }, this.opts.debounceMs);
    this.debounce.unref();
  }

  async reloadNow(): Promise<void> {
    if (this.reloading) { this.again = true; return this.reloading; }
    this.reloading = (async () => {
      do {
        this.again = false;
        for (const load of this.opts.loaders) {
          try { await load(); } catch (err) {
            this.opts.log(`[edge] reload failed, keeping last good state: ${(err as Error).message}`);
          }
        }
      } while (this.again && !this.stopped);
    })().finally(() => { this.reloading = null; });
    return this.reloading;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = this.opts.createListener();
    this.listener = client;
    let failed = false;
    const onFail = (err: unknown) => {
      if (failed || this.stopped) return;
      failed = true;
      this.opts.log(`[edge] LISTEN connection lost: ${(err as Error)?.message ?? err}; retrying in ${this.backoff}ms`);
      client.removeAllListeners('notification');
      client.end().catch(() => {});
      if (this.listener === client) this.listener = null;
      this.reconnectTimer = setTimeout(() => void this.connect(), this.backoff);
      this.reconnectTimer.unref();
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    client.on('error', onFail);
    client.on('end', () => onFail(new Error('connection ended')));
    client.on('notification', (msg) => { if (msg.channel === 'nav_routes') this.schedule(); });
    try {
      await client.connect();
      await client.query('LISTEN nav_routes');
      this.backoff = 500;
      this.schedule(); // catch up on anything missed while disconnected
    } catch (err) {
      onFail(err);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const l = this.listener;
    this.listener = null;
    if (l) { l.removeAllListeners(); l.on('error', () => {}); await l.end().catch(() => {}); }
  }
}
