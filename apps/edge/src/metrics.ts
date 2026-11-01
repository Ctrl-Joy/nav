// Per-service, per-minute HTTP metrics, flushed to `http_metrics` every 10 s, together with each service's
// latest request time (`services.last_request_at`, which drives free instance sleep).
// Failures are logged and never propagate to request handling.

export interface Bucket {
  serviceId: string;
  minute: string; // ISO timestamp floored to the minute
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  latencySum: number;
  latencyMax: number;
  bytesOut: number;
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const MAX_BUCKETS = 20_000;

export class Metrics {
  private buckets = new Map<string, Bucket>();
  /** serviceId -> time of its latest request since the last flush. */
  private lastSeen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private db: Queryable | null;
  private log: (m: string) => void;

  constructor(db: Queryable | null, log: (m: string) => void = (m) => console.error(m)) {
    this.db = db;
    this.log = log;
  }

  record(serviceId: string, status: number, latencyMs: number, bytesOut: number, now = Date.now()): void {
    try {
      const seen = this.lastSeen.get(serviceId);
      if (seen === undefined ? this.lastSeen.size < MAX_BUCKETS : seen < now) this.lastSeen.set(serviceId, now);
      const minute = new Date(now - (now % 60_000)).toISOString();
      const key = `${serviceId}|${minute}`;
      let b = this.buckets.get(key);
      if (!b) {
        if (this.buckets.size >= MAX_BUCKETS) return;
        b = { serviceId, minute, requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, latencySum: 0, latencyMax: 0, bytesOut: 0 };
        this.buckets.set(key, b);
      }
      b.requests++;
      if (status >= 500) b.s5xx++;
      else if (status >= 400) b.s4xx++;
      else if (status >= 300) b.s3xx++;
      else if (status >= 200) b.s2xx++;
      const ms = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
      b.latencySum += ms;
      if (ms > b.latencyMax) b.latencyMax = ms;
      b.bytesOut += Number.isFinite(bytesOut) && bytesOut > 0 ? bytesOut : 0;
    } catch { /* never affect traffic */ }
  }

  snapshot(): Bucket[] { return [...this.buckets.values()].map((b) => ({ ...b })); }

  start(intervalMs = 10_000): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.db || (this.buckets.size === 0 && this.lastSeen.size === 0)) return;
    const batch = [...this.buckets.values()];
    this.buckets = new Map();
    const seen = [...this.lastSeen];
    this.lastSeen = new Map();
    const db = this.db;
    let written = 0;
    this.flushing = (async () => {
      if (seen.length) {
        try {
          await db.query(
            `UPDATE services s SET last_request_at = v.t FROM unnest($1::text[], $2::timestamptz[]) AS v(id, t)
             WHERE s.id = v.id AND (s.last_request_at IS NULL OR s.last_request_at < v.t)`,
            [seen.map(([id]) => id), seen.map(([, t]) => new Date(t).toISOString())],
          );
        } catch (err) {
          this.log(`[edge] last-request flush failed: ${(err as Error).message}`);
          for (const [id, t] of seen) if ((this.lastSeen.get(id) ?? 0) < t) this.lastSeen.set(id, t);
        }
      }
      if (!batch.length) return;
      try {
        for (let i = 0; i < batch.length; i += 500) {
          const chunk = batch.slice(i, i + 500);
          const values: unknown[] = [];
          const tuples = chunk.map((b, j) => {
            values.push(b.serviceId, b.minute, b.requests, b.s2xx, b.s3xx, b.s4xx, b.s5xx, b.latencySum, b.latencyMax, b.bytesOut);
            const o = j * 10;
            return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
          });
          await db.query(
            `INSERT INTO http_metrics (service_id, minute, requests, s2xx, s3xx, s4xx, s5xx, latency_ms_sum, latency_ms_max, bytes_out)
             VALUES ${tuples.join(',')}
             ON CONFLICT (service_id, minute) DO UPDATE SET
               requests = http_metrics.requests + EXCLUDED.requests,
               s2xx = http_metrics.s2xx + EXCLUDED.s2xx,
               s3xx = http_metrics.s3xx + EXCLUDED.s3xx,
               s4xx = http_metrics.s4xx + EXCLUDED.s4xx,
               s5xx = http_metrics.s5xx + EXCLUDED.s5xx,
               latency_ms_sum = http_metrics.latency_ms_sum + EXCLUDED.latency_ms_sum,
               latency_ms_max = GREATEST(http_metrics.latency_ms_max, EXCLUDED.latency_ms_max),
               bytes_out = http_metrics.bytes_out + EXCLUDED.bytes_out`,
            values,
          );
          written = i + chunk.length;
        }
      } catch (err) {
        this.log(`[edge] metrics flush failed: ${(err as Error).message}`);
        // Merge unwritten data back (bounded) so a short DB blip loses nothing.
        const cutoff = Date.now() - 15 * 60_000;
        for (const b of batch.slice(written)) {
          if (Date.parse(b.minute) < cutoff) continue;
          const key = `${b.serviceId}|${b.minute}`;
          const cur = this.buckets.get(key);
          if (!cur) { if (this.buckets.size < MAX_BUCKETS) this.buckets.set(key, b); continue; }
          cur.requests += b.requests; cur.s2xx += b.s2xx; cur.s3xx += b.s3xx; cur.s4xx += b.s4xx; cur.s5xx += b.s5xx;
          cur.latencySum += b.latencySum; cur.latencyMax = Math.max(cur.latencyMax, b.latencyMax); cur.bytesOut += b.bytesOut;
        }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
