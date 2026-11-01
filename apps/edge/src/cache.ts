// Edge caching for web services: an in-memory LRU of GET responses the app marks cacheable. Only responses that
// say so (Cache-Control public / s-maxage / max-age, no private/no-store/no-cache, no Set-Cookie, Vary limited to
// Accept-Encoding) are stored, for at most their stated lifetime. A deploy or an explicit purge empties a
// service's entries.
import type http from 'node:http';

export interface CachedResponse { status: number; headers: Record<string, string | string[]>; body: Buffer; storedAt: number; expiresAt: number }

const MAX_ENTRY = 8 * 1048576;

export function freshFor(headers: http.IncomingHttpHeaders, maxTtlS: number): number {
  const cc = String(headers['cache-control'] ?? '').toLowerCase();
  if (!cc || /(^|,)\s*(private|no-store|no-cache)\b/.test(cc)) return 0;
  if (headers['set-cookie']) return 0;
  const vary = String(headers.vary ?? '').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean);
  if (vary.some((v) => v !== 'accept-encoding')) return 0;
  const s = /s-maxage=(\d+)/.exec(cc)?.[1] ?? /max-age=(\d+)/.exec(cc)?.[1];
  const ttl = s ? Number(s) : 0;
  return Math.min(ttl, maxTtlS);
}

export class EdgeCache {
  private entries = new Map<string, CachedResponse & { serviceId: string; size: number }>();
  private bytes = 0;
  private maxBytes: number;

  constructor(maxBytes = 64 * 1048576) {
    this.maxBytes = maxBytes;
  }

  static key(serviceId: string, host: string, url: string, acceptEncoding: string | undefined): string {
    const enc = /\bbr\b/.test(acceptEncoding ?? '') ? 'br' : /\bgzip\b/.test(acceptEncoding ?? '') ? 'gzip' : 'id';
    return `${serviceId}|${host}|${url}|${enc}`;
  }

  get(key: string): CachedResponse | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { this.delete(key); return null; }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  set(key: string, serviceId: string, value: CachedResponse): void {
    const size = value.body.length + 512;
    if (size > MAX_ENTRY) return;
    this.delete(key);
    this.entries.set(key, { ...value, serviceId, size });
    this.bytes += size;
    for (const k of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(k);
    }
  }

  purge(serviceId: string): number {
    let n = 0;
    for (const [k, e] of this.entries) if (e.serviceId === serviceId) { this.delete(k); n++; }
    return n;
  }

  private delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.bytes -= e.size;
    this.entries.delete(key);
  }

  get size(): number { return this.entries.size; }
}

export const MAX_BODY = MAX_ENTRY;
