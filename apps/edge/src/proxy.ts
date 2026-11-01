// The edge request pipeline: validation → health/ACME → host routing → service state →
// static serving or streaming reverse proxy (HTTP + WebSocket) with round-robin + passive health.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { rawPage, sendPage, type PageKind } from './pages.ts';
import { sanitizeHost, type Route, type RouteTable, type Upstream } from './routes.ts';
import { serveStatic } from './static.ts';
import { ipAllowed } from './access.ts';
import { EdgeCache, MAX_BODY, freshFor } from './cache.ts';
import type { Metrics } from './metrics.ts';

export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers',
  'transfer-encoding', 'upgrade', 'proxy-connection', 'http2-settings',
]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const STRIP_REQUEST = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'expect', 'x-request-id']);
const STRIP_RESPONSE = new Set(['x-request-id', 'nav-routing']);
const REQUEST_ID_RE = /^[A-Za-z0-9._:@+=\/-]{8,128}$/;
const ACME_PREFIX = '/.well-known/acme-challenge/';

export interface EdgeOptions {
  table: RouteTable;
  production?: boolean;
  metrics?: Metrics | null;
  accessLog?: boolean;
  acmeLookup?: (token: string) => Promise<string | null>;
  /** True when a real (non-default) certificate exists for the host. */
  hasCert?: (host: string) => boolean;
  forceHttps?: boolean;
  httpsPort?: number;
  maxUrlLength?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  ejectMs?: number;
  /** Asks the control plane to wake a sleeping free instance. Must be idempotent; it is repeated while waiting. */
  wake?: (serviceId: string) => Promise<void>;
  /** How long a request is held while its service wakes up. */
  wakeTimeoutMs?: number;
  /** Interval between repeated wake signals while the service is still marked sleeping. */
  wakeSignalMs?: number;
  log?: (msg: string) => void;
}

interface RequestCtx {
  start: bigint;
  requestId: string;
  host: string;
  serviceId: string | null;
  upstream: string;
  secure: boolean;
  /** This request started a wake-up (answered with `x-nav-woke: 1`). */
  woke: boolean;
}

// --- load balancing -----------------------------------------------------------------------------

export class Balancer {
  private rr = new Map<string, number>();
  private ejected = new Map<string, number>();
  private ejectMs: number;
  constructor(ejectMs = 10_000) { this.ejectMs = ejectMs; }

  static key(u: { host: string; port: number }): string { return `${u.host}:${u.port}`; }

  isHealthy(u: Upstream, now = Date.now()): boolean {
    const until = this.ejected.get(Balancer.key(u));
    if (until === undefined) return true;
    if (until <= now) { this.ejected.delete(Balancer.key(u)); return true; }
    return false;
  }

  eject(u: Upstream): void { this.ejected.set(Balancer.key(u), Date.now() + this.ejectMs); }

  /** Round-robin over healthy upstreams, preferring anything other than `avoid`. */
  pick(serviceId: string, upstreams: Upstream[], avoid?: Upstream): Upstream | null {
    const now = Date.now();
    const healthy = upstreams.filter((u) => this.isHealthy(u, now));
    let candidates = avoid ? healthy.filter((u) => Balancer.key(u) !== Balancer.key(avoid)) : healthy;
    if (candidates.length === 0) candidates = healthy;
    if (candidates.length === 0) return null;
    const n = this.rr.get(serviceId) ?? 0;
    this.rr.set(serviceId, (n + 1) % 1_000_000_000);
    return candidates[n % candidates.length];
  }
}

// --- helpers ------------------------------------------------------------------------------------

function connectionTokens(v: string | string[] | undefined): Set<string> {
  const s = new Set<string>();
  const vals = Array.isArray(v) ? v : v ? [v] : [];
  for (const x of vals) for (const t of x.split(',')) { const k = t.trim().toLowerCase(); if (k) s.add(k); }
  return s;
}

export function clientIp(addr: string | undefined): string {
  if (!addr) return 'unknown';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isLoopback(addr: string | undefined): boolean {
  const a = clientIp(addr);
  return a === '::1' || a.startsWith('127.');
}

function existingXff(v: string | string[] | undefined): string[] {
  const vals = Array.isArray(v) ? v : v ? [v] : [];
  const out: string[] = [];
  for (const x of vals) for (const t of x.split(',')) {
    const ip = t.trim();
    if (ip && ip.length <= 45 && /^[0-9a-fA-F:.]+$/.test(ip) && net.isIP(ip)) out.push(ip);
  }
  return out.slice(-20);
}

export function buildUpstreamHeaders(
  req: http.IncomingMessage,
  rc: { requestId: string; secure: boolean },
  opts: { upgrade?: boolean; hostHeader?: string } = {},
): http.OutgoingHttpHeaders {
  const conn = connectionTokens(req.headers.connection);
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || conn.has(k) || STRIP_REQUEST.has(k)) continue;
    out[k] = v;
  }
  const ip = clientIp(req.socket.remoteAddress);
  out['x-forwarded-for'] = [...existingXff(req.headers['x-forwarded-for']), ip].join(', ');
  out['x-forwarded-proto'] = rc.secure ? 'https' : 'http';
  out['x-forwarded-host'] = String(req.headers.host ?? '');
  out['x-forwarded-port'] = String(req.socket.localPort ?? (rc.secure ? 443 : 80));
  out['x-real-ip'] = ip;
  out['x-request-id'] = rc.requestId;
  if (opts.hostHeader) out.host = opts.hostHeader;
  if (opts.upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = String(req.headers.upgrade ?? '');
  }
  return out;
}

function responseHeaders(pres: http.IncomingMessage, extra: [string, string][]): string[] {
  const conn = connectionTokens(pres.headers.connection);
  const raw = pres.rawHeaders;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(k) || conn.has(k) || STRIP_RESPONSE.has(k)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  for (const [k, v] of extra) out.push(k, v);
  return out;
}

interface ForwardTarget {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  path: string;
  hostHeader?: string;
  label: string;
  agent: http.Agent;
  /** Set when the response may be stored in the edge cache under this key. */
  cache?: { key: string; serviceId: string; maxTtlSeconds: number };
}

// --- Edge ---------------------------------------------------------------------------------------

export class Edge {
  readonly table: RouteTable;
  readonly cache = new EdgeCache();
  private cacheVersions = new Map<string, string>();
  readonly balancer: Balancer;
  private opts: Required<Omit<EdgeOptions, 'metrics' | 'acmeLookup' | 'hasCert' | 'table' | 'wake'>> & EdgeOptions;
  private agents = new Map<string, http.Agent>();
  private upgraded = new Set<Duplex>();
  private acmeCache = new Map<string, { value: string; at: number }>();
  /** One wake-up per service at a time; concurrent requests wait on the same promise. */
  private waking = new Map<string, Promise<boolean>>();

  constructor(opts: EdgeOptions) {
    this.table = opts.table;
    this.opts = {
      production: false, accessLog: false, forceHttps: false, httpsPort: 443, maxUrlLength: 8192,
      connectTimeoutMs: 5_000, idleTimeoutMs: 300_000, ejectMs: 10_000, wakeTimeoutMs: 60_000, wakeSignalMs: 5_000,
      log: (m) => console.error(m),
      ...opts,
    };
    this.balancer = new Balancer(this.opts.ejectMs);
  }

  /** Attach request/upgrade/clientError handlers and timeouts to an http(s) server. */
  attach(server: http.Server | https.Server, secure: boolean): void {
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = this.opts.idleTimeoutMs;
    server.timeout = this.opts.idleTimeoutMs;
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => this.handleRequest(req, res, secure));
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => this.handleUpgrade(req, socket, head, secure));
    server.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
      if (!socket.writable || err.code === 'ECONNRESET') { socket.destroy(); return; }
      const kind: PageKind = err.code === 'HPE_HEADER_OVERFLOW' ? 'headers_too_large'
        : err.code === 'HPE_URI_TOO_LONG' ? 'uri_too_long' : 'bad_request';
      socket.end(rawPage(kind));
    });
  }

  /** Destroy upgraded (WebSocket) connections and idle agent sockets. */
  closeAll(): void {
    for (const s of this.upgraded) s.destroy();
    this.upgraded.clear();
    for (const a of this.agents.values()) a.destroy();
  }

  get upgradedCount(): number { return this.upgraded.size; }

  private agentFor(protocol: 'http:' | 'https:', host: string, port: number): http.Agent {
    const key = `${protocol}//${host}:${port}`;
    let a = this.agents.get(key);
    if (!a) {
      const o = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 512, maxFreeSockets: 64, timeout: this.opts.idleTimeoutMs, scheduling: 'lifo' as const };
      a = protocol === 'https:' ? new https.Agent(o) : new http.Agent(o);
      this.agents.set(key, a);
    }
    return a;
  }

  private newCtx(req: http.IncomingMessage, secure: boolean): RequestCtx {
    const given = req.headers['x-request-id'];
    const requestId = typeof given === 'string' && REQUEST_ID_RE.test(given) ? given : randomUUID();
    return { start: process.hrtime.bigint(), requestId, host: '-', serviceId: null, upstream: '-', secure, woke: false };
  }

  private finish(req: http.IncomingMessage, res: http.ServerResponse, rc: RequestCtx): void {
    const sock = req.socket;
    const startBytes = sock.bytesWritten ?? 0;
    let done = false;
    const onDone = () => {
      if (done) return;
      done = true;
      const ms = Number(process.hrtime.bigint() - rc.start) / 1e6;
      const status = res.headersSent ? res.statusCode : 499;
      if (rc.serviceId && this.opts.metrics) {
        try { this.opts.metrics.record(rc.serviceId, status, ms, (sock.bytesWritten ?? 0) - startBytes); } catch { /* ignore */ }
      }
      if (this.opts.accessLog) {
        const p = (req.url ?? '/').split('?')[0].slice(0, 512);
        process.stdout.write(`${req.method} ${rc.host} ${p} ${status} ${ms.toFixed(1)}ms ${rc.upstream}\n`);
      }
    };
    res.once('finish', onDone);
    res.once('close', onDone);
  }

  private page(req: http.IncomingMessage, res: http.ServerResponse, rc: RequestCtx, kind: PageKind, extra: Record<string, string> = {}): void {
    sendPage(req, res, kind, { 'x-request-id': rc.requestId, ...extra }, rc.requestId);
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, secure: boolean): void {
    const rc = this.newCtx(req, secure);
    this.finish(req, res, rc);
    req.on('error', () => res.destroy());
    try {
      this.route(req, res, rc);
    } catch (err) {
      this.opts.log(`[edge] request error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) this.page(req, res, rc, 'bad_gateway');
      else res.destroy();
    }
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, rc: RequestCtx): void {
    const url = req.url ?? '/';
    if (url.length > this.opts.maxUrlLength) { res.shouldKeepAlive = false; this.page(req, res, rc, 'uri_too_long'); return; }
    if (req.headers['content-length'] !== undefined && req.headers['transfer-encoding'] !== undefined) {
      res.shouldKeepAlive = false;
      this.page(req, res, rc, 'bad_request', { connection: 'close' });
      return;
    }
    if (!url.startsWith('/')) { this.page(req, res, rc, 'bad_request'); return; }
    const pathOnly = url.split('?')[0];

    if (pathOnly === '/__nav/health' && isLoopback(req.socket.remoteAddress)) {
      const body = JSON.stringify({ ok: true, routes: this.table.size });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-request-id': rc.requestId });
      res.end(body);
      return;
    }

    const host = sanitizeHost(req.headers.host);
    if (!host) { this.page(req, res, rc, 'bad_request'); return; }
    rc.host = host;

    if (pathOnly.startsWith(ACME_PREFIX)) { void this.serveAcme(req, res, rc, pathOnly.slice(ACME_PREFIX.length)); return; }

    const match = this.table.lookup(host);
    if (!match) { this.page(req, res, rc, 'not_found'); return; }
    const route = match.route;
    rc.serviceId = route.serviceId;

    if (match.redirectTo) {
      const portPart = /:(\d+)$/.exec(String(req.headers.host ?? ''))?.[0] ?? '';
      const location = `${rc.secure ? 'https' : 'http'}://${match.redirectTo}${portPart}${url}`;
      res.writeHead(301, { location, 'content-length': 0, 'x-request-id': rc.requestId });
      res.end();
      return;
    }
    if (this.opts.forceHttps && !rc.secure && this.opts.hasCert?.(host)) {
      const port = this.opts.httpsPort === 443 ? '' : `:${this.opts.httpsPort}`;
      res.writeHead(301, { location: `https://${host}${port}${url}`, 'content-length': 0, 'x-request-id': rc.requestId });
      res.end();
      return;
    }
    if (route.suspended) { this.page(req, res, rc, 'suspended'); return; }
    if (route.maintenanceMode) { this.page(req, res, rc, 'maintenance'); return; }
    if (!ipAllowed(req.socket.remoteAddress, route.ipRules)) { this.page(req, res, rc, 'ip_blocked'); return; }

    if (route.type === 'static') {
      res.setHeader('x-request-id', rc.requestId);
      serveStatic(req, res, route, {
        requestId: rc.requestId,
        proxyUrl: (rq, rs, target) => this.proxyExternal(rq, rs, rc, target),
      });
      return;
    }
    if (this.asleep(route)) { void this.wakeThenProxy(req, res, route, rc); return; }
    this.proxyToService(req, res, route, rc, 0);
  }

  // --- free instance sleep ------------------------------------------------------------------------

  /** A sleeping web service, or one whose wake-up is still in progress. */
  private asleep(route: Route): boolean {
    return route.type === 'web' && (route.sleeping || this.waking.has(route.serviceId));
  }

  /**
   * Resolves true once the service is awake with a healthy upstream, false after `wakeTimeoutMs` (or if the
   * service went away / was suspended). The first caller starts the wake; later ones share it.
   */
  private wakeUp(route: Route, host: string, rc: RequestCtx): Promise<boolean> {
    const pending = this.waking.get(route.serviceId);
    if (pending) return pending;
    rc.woke = true;
    const id = route.serviceId;
    const p = (async () => {
      const deadline = Date.now() + this.opts.wakeTimeoutMs;
      let nextSignal = 0;
      while (Date.now() < deadline) {
        const r = this.table.lookup(host)?.route;
        if (!r || r.serviceId !== id || r.suspended) return false;
        if (!r.sleeping && r.upstreams.some((u) => this.balancer.isHealthy(u))) return true;
        // Repeat the signal while the control plane has not picked it up (missed NOTIFY, control restart).
        if (r.sleeping && Date.now() >= nextSignal) {
          nextSignal = Date.now() + this.opts.wakeSignalMs;
          this.opts.wake?.(id).catch((err) => this.opts.log(`[edge] wake signal for ${id} failed: ${(err as Error).message}`));
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    })().finally(() => this.waking.delete(id));
    this.waking.set(id, p);
    return p;
  }

  private async wakeThenProxy(req: http.IncomingMessage, res: http.ServerResponse, route: Route, rc: RequestCtx): Promise<void> {
    const ok = await this.wakeUp(route, rc.host, rc);
    if (res.destroyed || res.headersSent) return;
    const fresh = this.table.lookup(rc.host)?.route;
    if (!ok || !fresh) { this.page(req, res, rc, 'waking', { 'retry-after': '10' }); return; }
    this.proxyToService(req, res, fresh, rc, 0);
  }

  private async serveAcme(req: http.IncomingMessage, res: http.ServerResponse, rc: RequestCtx, token: string): Promise<void> {
    let value: string | null = null;
    if (/^[A-Za-z0-9_-]{1,256}$/.test(token)) {
      const c = this.acmeCache.get(token);
      if (c && Date.now() - c.at < 60_000) value = c.value;
      else if (this.opts.acmeLookup) {
        try { value = await this.opts.acmeLookup(token); } catch (err) {
          this.opts.log(`[edge] acme lookup failed: ${(err as Error).message}`);
        }
        if (value) {
          if (this.acmeCache.size > 1000) this.acmeCache.clear();
          this.acmeCache.set(token, { value, at: Date.now() });
        }
      }
    }
    if (res.destroyed) return;
    if (!value) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 9, 'x-request-id': rc.requestId });
      res.end(req.method === 'HEAD' ? undefined : 'not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(value), 'cache-control': 'no-store', 'x-request-id': rc.requestId });
    res.end(req.method === 'HEAD' ? undefined : value);
  }

  /** Serves a cached response if there is a fresh one; returns the cache target for a miss, or null. */
  private fromCache(req: http.IncomingMessage, res: http.ServerResponse, route: Route, rc: RequestCtx): ForwardTarget['cache'] | 'hit' | null {
    if (!route.edgeCache.enabled || (req.method !== 'GET' && req.method !== 'HEAD') || req.headers.authorization) return null;
    // A new deploy or an explicit purge changes the version: drop everything cached for the old one.
    if (this.cacheVersions.get(route.serviceId) !== route.cacheVersion) {
      this.cache.purge(route.serviceId);
      this.cacheVersions.set(route.serviceId, route.cacheVersion);
    }
    const key = EdgeCache.key(route.serviceId, rc.host, req.url ?? '/', req.headers['accept-encoding'] as string | undefined);
    const hit = this.cache.get(key);
    if (!hit) return { key, serviceId: route.serviceId, maxTtlSeconds: route.edgeCache.maxTtlSeconds };
    rc.upstream = 'cache';
    res.writeHead(hit.status, { ...hit.headers, age: String(Math.floor((Date.now() - hit.storedAt) / 1000)), 'x-nav-cache': 'HIT', 'x-request-id': rc.requestId });
    res.end(req.method === 'HEAD' ? undefined : hit.body);
    return 'hit';
  }

  private proxyToService(req: http.IncomingMessage, res: http.ServerResponse, route: Route, rc: RequestCtx, attempt: number, avoid?: Upstream): void {
    const cache = attempt === 0 ? this.fromCache(req, res, route, rc) : null;
    if (cache === 'hit') return;
    const up = this.balancer.pick(route.serviceId, route.upstreams, avoid);
    if (!up) { this.page(req, res, rc, 'no_upstream'); return; }
    rc.upstream = `${up.host}:${up.port}`;
    const bodyless = req.headers['transfer-encoding'] === undefined &&
      (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
    const canRetry = attempt === 0 && bodyless && IDEMPOTENT.has(req.method ?? '');
    this.forward(req, res, rc, {
      protocol: 'http:', hostname: up.host, port: up.port, path: req.url ?? '/', label: up.id,
      agent: this.agentFor('http:', up.host, up.port), cache: cache ?? undefined,
    }, (connectErr) => {
      if (connectErr) {
        this.balancer.eject(up);
        this.opts.log(`[edge] upstream ${up.host}:${up.port} (${route.slug}) unreachable; ejected for ${this.opts.ejectMs}ms`);
      }
      if (canRetry) { this.proxyToService(req, res, route, rc, 1, up); return true; }
      return false;
    });
  }

  private proxyExternal(req: http.IncomingMessage, res: http.ServerResponse, rc: RequestCtx, url: URL): void {
    const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
    const port = url.port ? Number(url.port) : protocol === 'https:' ? 443 : 80;
    rc.upstream = url.host;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    this.forward(req, res, rc, {
      protocol, hostname, port, path: `${url.pathname}${url.search}`, hostHeader: url.host, label: url.host,
      agent: this.agentFor(protocol, hostname, port),
    }, () => false);
  }

  /** Stream a request to a target. `onFail(connectErr)` returns true when it took over (retry). */
  private forward(
    req: http.IncomingMessage, res: http.ServerResponse, rc: RequestCtx, t: ForwardTarget,
    onFail: (connectErr: boolean) => boolean,
  ): void {
    const headers = buildUpstreamHeaders(req, rc, { hostHeader: t.hostHeader });
    const mod = t.protocol === 'https:' ? https : http;
    const preq = mod.request({
      protocol: t.protocol, hostname: t.hostname, port: t.port, method: req.method, path: t.path,
      headers, agent: t.agent, setHost: !headers.host, servername: t.protocol === 'https:' && !net.isIP(t.hostname) ? t.hostname : undefined,
    });
    let connected = false;
    let responded = false;
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;

    preq.on('socket', (s: net.Socket) => {
      const readyEvent = t.protocol === 'https:' ? 'secureConnect' : 'connect';
      if (!s.connecting) { // reused keep-alive socket
        connected = true;
        return;
      }
      connectTimer = setTimeout(() => {
        const e = Object.assign(new Error('upstream connect timeout'), { code: 'ETIMEDOUT' });
        preq.destroy(e);
      }, this.opts.connectTimeoutMs);
      s.once(readyEvent, () => { connected = true; if (connectTimer) clearTimeout(connectTimer); });
    });
    preq.setTimeout(this.opts.idleTimeoutMs, () => preq.destroy(Object.assign(new Error('upstream idle timeout'), { code: 'EIDLE' })));

    preq.on('response', (pres) => {
      responded = true;
      if (connectTimer) clearTimeout(connectTimer);
      const extra: [string, string][] = [['x-request-id', rc.requestId]];
      if (!this.opts.production) extra.push(['nav-routing', t.label]);
      if (rc.woke) extra.push(['x-nav-woke', '1']);
      const ttl = t.cache && req.method === 'GET' && pres.statusCode === 200 ? freshFor(pres.headers, t.cache.maxTtlSeconds) : 0;
      if (t.cache) extra.push(['x-nav-cache', ttl > 0 ? 'MISS' : 'BYPASS']);
      if (ttl > 0 && Number(pres.headers['content-length'] ?? 0) <= MAX_BODY) {
        const chunks: Buffer[] = [];
        let size = 0;
        pres.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
        pres.on('end', () => {
          if (size > MAX_BODY || !pres.complete) return;
          const flat = responseHeaders(pres, []);
          const headers: Record<string, string | string[]> = {};
          for (let i = 0; i < flat.length; i += 2) {
            const k = flat[i].toLowerCase();
            if (k === 'age') continue;
            const prev = headers[k];
            headers[k] = prev === undefined ? flat[i + 1] : ([] as string[]).concat(prev, flat[i + 1]);
          }
          const now = Date.now();
          this.cache.set(t.cache!.key, t.cache!.serviceId, { status: 200, headers, body: Buffer.concat(chunks), storedAt: now, expiresAt: now + ttl * 1000 });
        });
      }
      const hdrs = responseHeaders(pres, extra);
      const status = pres.statusCode ?? 502;
      try {
        res.writeHead(status, pres.statusMessage, hdrs);
      } catch {
        try { res.writeHead(status, hdrs); } catch { res.destroy(); pres.destroy(); return; }
      }
      pres.on('error', () => res.destroy());
      pres.on('aborted', () => res.destroy());
      pres.pipe(res);
    });

    preq.on('error', (err: NodeJS.ErrnoException) => {
      if (connectTimer) clearTimeout(connectTimer);
      if (settled) return;
      settled = true;
      if (responded) { res.destroy(); return; }
      if (res.destroyed || req.destroyed && !req.complete) return;
      const connectErr = !connected;
      if (onFail(connectErr)) return;
      if (res.headersSent) { res.destroy(); return; }
      this.page(req, res, rc, err.code === 'ETIMEDOUT' || err.code === 'EIDLE' ? 'gateway_timeout' : 'bad_gateway');
    });

    res.on('close', () => {
      if (!res.writableFinished) preq.destroy();
    });

    const bodyless = req.headers['transfer-encoding'] === undefined &&
      (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
    if (bodyless) { req.resume(); preq.end(); } else req.pipe(preq);
  }

  // --- WebSocket / upgrade ------------------------------------------------------------------------

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, secure: boolean): void {
    const rc = this.newCtx(req, secure);
    socket.on('error', () => socket.destroy());
    const fail = (kind: PageKind) => { this.logUpgrade(req, rc, Number(rawPage(kind).slice(9, 12))); socket.end(rawPage(kind, rc.requestId)); };
    const url = req.url ?? '/';
    if (url.length > this.opts.maxUrlLength) return fail('uri_too_long');
    if (!url.startsWith('/')) return fail('bad_request');
    const host = sanitizeHost(req.headers.host);
    if (!host) return fail('bad_request');
    rc.host = host;
    const match = this.table.lookup(host);
    if (!match || match.redirectTo) return fail('not_found');
    const route = match.route;
    rc.serviceId = route.serviceId;
    if (route.suspended) return fail('suspended');
    if (route.maintenanceMode) return fail('maintenance');
    if (!ipAllowed(req.socket.remoteAddress, route.ipRules)) return fail('ip_blocked');
    if (route.type === 'static') return fail('static_not_found');
    this.upgraded.add(socket);
    socket.once('close', () => this.upgraded.delete(socket));
    if (this.asleep(route)) { void this.wakeThenUpgrade(req, socket, head, route, rc); return; }
    this.connectUpgrade(req, socket, head, route, rc, 0);
  }

  private async wakeThenUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, route: Route, rc: RequestCtx): Promise<void> {
    const ok = await this.wakeUp(route, rc.host, rc);
    if (socket.destroyed) return;
    const fresh = this.table.lookup(rc.host)?.route;
    if (!ok || !fresh) { this.logUpgrade(req, rc, 503); socket.end(rawPage('waking', rc.requestId)); return; }
    this.connectUpgrade(req, socket, head, fresh, rc, 0);
  }

  private logUpgrade(req: http.IncomingMessage, rc: RequestCtx, status: number): void {
    const ms = Number(process.hrtime.bigint() - rc.start) / 1e6;
    if (rc.serviceId && this.opts.metrics) {
      try { this.opts.metrics.record(rc.serviceId, status, ms, 0); } catch { /* ignore */ }
    }
    if (this.opts.accessLog) {
      process.stdout.write(`${req.method} ${rc.host} ${(req.url ?? '/').split('?')[0].slice(0, 512)} ${status} ${ms.toFixed(1)}ms ${rc.upstream}\n`);
    }
  }

  private connectUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, route: Route, rc: RequestCtx, attempt: number, avoid?: Upstream): void {
    const up = this.balancer.pick(route.serviceId, route.upstreams, avoid);
    if (!up) { this.logUpgrade(req, rc, 503); socket.end(rawPage('no_upstream', rc.requestId)); return; }
    rc.upstream = `${up.host}:${up.port}`;
    const preq = http.request({
      hostname: up.host, port: up.port, method: req.method, path: req.url, agent: false,
      headers: buildUpstreamHeaders(req, rc, { upgrade: true }), setHost: false,
    });
    let connected = false;
    const connectTimer = setTimeout(() => preq.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), this.opts.connectTimeoutMs);
    preq.on('socket', (s: net.Socket) => s.once('connect', () => { connected = true; clearTimeout(connectTimer); }));
    const onClientGone = () => preq.destroy();
    socket.once('close', onClientGone);

    preq.on('upgrade', (pres, psock: Duplex, phead: Buffer) => {
      clearTimeout(connectTimer);
      socket.off('close', onClientGone);
      const extra: [string, string][] = [['x-request-id', rc.requestId]];
      if (!this.opts.production) extra.push(['nav-routing', up.id]);
      if (rc.woke) extra.push(['x-nav-woke', '1']);
      // keep Connection/Upgrade for the 101 handshake
      const lines = [`HTTP/1.1 ${pres.statusCode ?? 101} ${pres.statusMessage || 'Switching Protocols'}`];
      const raw = pres.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const k = raw[i].toLowerCase();
        if (STRIP_RESPONSE.has(k) || k === 'keep-alive' || k === 'transfer-encoding' || k === 'proxy-connection') continue;
        lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      for (const [k, v] of extra) lines.push(`${k}: ${v}`);
      this.logUpgrade(req, rc, pres.statusCode ?? 101);
      if (socket.destroyed) { psock.destroy(); return; }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (phead && phead.length) socket.write(phead);
      if (head && head.length) psock.write(head);
      this.upgraded.add(psock);
      const idle = this.opts.idleTimeoutMs;
      if ('setTimeout' in psock) (psock as net.Socket).setTimeout(idle, () => psock.destroy());
      if ('setTimeout' in socket) (socket as net.Socket).setTimeout(idle, () => socket.destroy());
      if ('setNoDelay' in psock) (psock as net.Socket).setNoDelay(true);
      if ('setNoDelay' in socket) (socket as net.Socket).setNoDelay(true);
      psock.on('error', () => socket.destroy());
      socket.on('error', () => psock.destroy());
      psock.on('close', () => { this.upgraded.delete(psock); socket.destroy(); });
      socket.on('close', () => psock.destroy());
      psock.pipe(socket);
      socket.pipe(psock);
    });

    preq.on('response', (pres) => {
      // Upstream declined the upgrade: relay its response verbatim-ish and close.
      clearTimeout(connectTimer);
      socket.off('close', onClientGone);
      this.logUpgrade(req, rc, pres.statusCode ?? 502);
      const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage ?? ''}`];
      const raw = pres.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const k = raw[i].toLowerCase();
        if (HOP_BY_HOP.has(k) || STRIP_RESPONSE.has(k)) continue;
        lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      lines.push(`x-request-id: ${rc.requestId}`, 'connection: close');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      pres.pipe(socket);
      pres.on('error', () => socket.destroy());
    });

    preq.on('error', () => {
      clearTimeout(connectTimer);
      socket.off('close', onClientGone);
      if (socket.destroyed) return;
      if (!connected) {
        this.balancer.eject(up);
        if (attempt === 0) { this.connectUpgrade(req, socket, head, route, rc, 1, up); return; }
      }
      this.logUpgrade(req, rc, 502);
      socket.end(rawPage('bad_gateway', rc.requestId));
    });
    preq.end();
  }
}
