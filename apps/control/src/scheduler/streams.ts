// Telemetry export:
//  - Log streams: every log line of a workspace's services (and databases) is forwarded as RFC 5424 syslog over
//    TLS or TCP, or batched as JSON over HTTPS. A service-level stream overrides the workspace default.
//  - Metrics streams: CPU, memory and HTTP metrics pushed each minute as OTLP/HTTP JSON.
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { decrypt } from '@nav/shared/crypto';
import { one, q, type Row } from '../db/pool.ts';
import { assertPublicHost, assertPublicUrl } from '../lib/targets.ts';

const SEVERITY: Record<string, number> = { error: 3, warn: 4, info: 6, debug: 7 };
const MAX_BUFFER = 4 * 1048576;

/** "<PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG", facility user (1). */
export function syslogLine(l: Row, token: string | null): string {
  const pri = 8 + (SEVERITY[l.level] ?? 6);
  const ts = new Date(l.ts).toISOString();
  const host = (l.slug ?? 'nav').replace(/[^\x21-\x7e]/g, '').slice(0, 255) || 'nav';
  const app = (l.app ?? 'nav').replace(/[^\x21-\x7e]/g, '').slice(0, 48) || 'nav';
  const proc = (l.instance_id ?? l.deploy_id ?? '-').slice(0, 128);
  const msgid = (l.stream ?? '-').slice(0, 32);
  const sd = token ? `[nav@53595 token="${token.replace(/(["\\\]])/g, '\\$1')}"]` : '-';
  return `<${pri}>1 ${ts} ${host} ${app} ${proc} ${msgid} ${sd} ${String(l.message).replace(/\r?\n/g, ' ')}`;
}

/** A persistent syslog connection with a bounded buffer: reconnects with backoff, drops on overflow. */
class SyslogSink {
  private socket: net.Socket | null = null;
  private connecting = false;
  private backoff = 1000;
  private pending: string[] = [];
  private pendingBytes = 0;
  readonly key: string;
  private stream: Row;

  constructor(stream: Row) {
    this.stream = stream;
    this.key = `${stream.protocol}|${stream.endpoint}`;
  }

  send(line: string): void {
    // Octet-counting framing (RFC 6587), which every syslog-over-TCP receiver accepts.
    const framed = `${Buffer.byteLength(line)} ${line}`;
    if (this.socket && !this.socket.destroyed && this.socket.writable) { this.socket.write(framed); return; }
    if (this.pendingBytes + framed.length > MAX_BUFFER) return;
    this.pending.push(framed);
    this.pendingBytes += framed.length;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.socket) return;
    this.connecting = true;
    const [host, portStr] = splitHostPort(this.stream.endpoint);
    try {
      await assertPublicHost(host);
      const port = Number(portStr);
      const sock = this.stream.protocol === 'syslog-tls' ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
      await new Promise<void>((resolve, reject) => {
        sock.once(this.stream.protocol === 'syslog-tls' ? 'secureConnect' : 'connect', resolve);
        sock.once('error', reject);
        sock.setTimeout(10_000, () => sock.destroy(new Error('connect timeout')));
      });
      sock.setTimeout(0);
      sock.on('error', () => {});
      sock.on('close', () => { this.socket = null; });
      this.socket = sock;
      this.backoff = 1000;
      for (const p of this.pending.splice(0)) sock.write(p);
      this.pendingBytes = 0;
      await q('UPDATE log_streams SET last_error = NULL, last_sent_at = now() WHERE id = $1', [this.stream.id]);
    } catch (err) {
      await q('UPDATE log_streams SET last_error = $2 WHERE id = $1', [this.stream.id, (err as Error).message.slice(0, 300)]).catch(() => {});
      setTimeout(() => void this.connect(), this.backoff).unref();
      this.backoff = Math.min(this.backoff * 2, 60_000);
    } finally {
      this.connecting = false;
    }
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

function splitHostPort(endpoint: string): [string, string] {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(endpoint.trim());
  if (!m) throw new Error(`endpoint must be host:port, got "${endpoint}"`);
  return [m[1], m[2]];
}

export function startLogStreams(): void {
  const sinks = new Map<string, SyslogSink>();
  let lastId: number | null = null;
  void one('SELECT COALESCE(max(id),0) AS id FROM logs').then((r) => { lastId = Number(r?.id ?? 0); });
  let busy = false;

  setInterval(async () => {
    if (busy || lastId === null) return;
    busy = true;
    try {
      const streams = await q('SELECT * FROM log_streams');
      if (!streams.length) {
        lastId = Number((await one('SELECT COALESCE(max(id),0) AS id FROM logs'))?.id ?? lastId);
        return;
      }
      const rows = await q(
        `SELECT l.*, COALESCE(s.slug, d.slug) AS slug, COALESCE(s.name, d.name) AS app, COALESCE(s.workspace_id, d.workspace_id) AS workspace_id
         FROM logs l LEFT JOIN services s ON s.id = l.service_id LEFT JOIN databases d ON d.id = l.database_id
         WHERE l.id > $1 ORDER BY l.id LIMIT 5000`,
        [lastId],
      );
      if (!rows.length) return;
      lastId = Number(rows[rows.length - 1].id);
      const https: Map<string, { stream: Row; lines: Row[] }> = new Map();
      for (const l of rows) {
        if (!l.workspace_id) continue;
        // A service-specific stream wins; enabled=false there opts the service out of the workspace default.
        const s = streams.find((x) => x.service_id && x.service_id === l.service_id) ?? streams.find((x) => !x.service_id && x.workspace_id === l.workspace_id);
        if (!s?.enabled) continue;
        if (s.protocol === 'https') {
          const b = https.get(s.id) ?? { stream: s, lines: [] };
          b.lines.push(l);
          https.set(s.id, b);
          continue;
        }
        const key = `${s.protocol}|${s.endpoint}|${s.id}`;
        let sink = sinks.get(key);
        if (!sink) { sink = new SyslogSink(s); sinks.set(key, sink); }
        sink.send(syslogLine(l, s.token_enc ? decrypt(s.token_enc) : null));
      }
      for (const { stream, lines } of https.values()) {
        try {
          await assertPublicUrl(stream.endpoint);
          const body = lines.map((l) => JSON.stringify({ timestamp: new Date(l.ts).toISOString(), level: l.level, message: l.message, service: l.app, host: l.slug, stream: l.stream, instanceId: l.instance_id, deployId: l.deploy_id })).join('\n');
          const res = await fetch(stream.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-ndjson', ...(stream.token_enc ? { authorization: `Bearer ${decrypt(stream.token_enc)}` } : {}) },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          await res.body?.cancel().catch(() => {});
          await q('UPDATE log_streams SET last_error = $2::text, last_sent_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sent_at END WHERE id = $1', [stream.id, res.ok ? null : `HTTP ${res.status}`]);
        } catch (err) {
          await q('UPDATE log_streams SET last_error = $2 WHERE id = $1', [stream.id, (err as Error).message.slice(0, 300)]);
        }
      }
      // Sinks for streams that were deleted or changed.
      const live = new Set(streams.map((s) => `${s.protocol}|${s.endpoint}|${s.id}`));
      for (const [k, sink] of sinks) if (!live.has(k)) { sink.close(); sinks.delete(k); }
    } catch (err) {
      console.error('[streams] logs:', (err as Error).message);
    } finally {
      busy = false;
    }
  }, 1000);
}

/** OTLP/HTTP JSON gauge/sum points for the last minute of each service in the workspace. */
export async function otlpPayload(workspaceId: string): Promise<Record<string, unknown> | null> {
  const usage = await q(
    `SELECT s.id, s.name, s.slug, m.instance_id, avg(m.cpu) AS cpu, avg(m.mem_bytes) AS mem
     FROM metrics m JOIN services s ON s.id = m.service_id
     WHERE s.workspace_id = $1 AND m.ts > now() - interval '70 seconds' GROUP BY s.id, s.name, s.slug, m.instance_id`,
    [workspaceId],
  );
  const http = await q(
    `SELECT s.id, s.name, s.slug, sum(h.requests)::bigint AS requests, sum(h.s5xx)::bigint AS s5xx, sum(h.latency_ms_sum) AS lat, sum(h.bytes_out)::bigint AS bytes
     FROM http_metrics h JOIN services s ON s.id = h.service_id
     WHERE s.workspace_id = $1 AND h.minute >= date_trunc('minute', now()) - interval '1 minute' AND h.minute < date_trunc('minute', now())
     GROUP BY s.id, s.name, s.slug`,
    [workspaceId],
  );
  if (!usage.length && !http.length) return null;
  const now = `${BigInt(Date.now()) * 1_000_000n}`;
  const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
  const byService = new Map<string, { name: string; slug: string; metrics: unknown[] }>();
  const bucket = (id: string, name: string, slug: string) => {
    let b = byService.get(id);
    if (!b) { b = { name, slug, metrics: [] }; byService.set(id, b); }
    return b;
  };
  for (const u of usage) {
    const b = bucket(u.id, u.name, u.slug);
    b.metrics.push(
      { name: 'nav.instance.cpu.usage', unit: '{cpu}', gauge: { dataPoints: [{ timeUnixNano: now, asDouble: Number(u.cpu), attributes: attrs({ 'nav.instance.id': u.instance_id }) }] } },
      { name: 'nav.instance.memory.usage', unit: 'By', gauge: { dataPoints: [{ timeUnixNano: now, asInt: String(Math.round(Number(u.mem))), attributes: attrs({ 'nav.instance.id': u.instance_id }) }] } },
    );
  }
  for (const h of http) {
    const b = bucket(h.id, h.name, h.slug);
    const reqs = Number(h.requests);
    b.metrics.push(
      { name: 'nav.http.requests', unit: '{request}', gauge: { dataPoints: [{ timeUnixNano: now, asInt: String(reqs) }] } },
      { name: 'nav.http.server_errors', unit: '{request}', gauge: { dataPoints: [{ timeUnixNano: now, asInt: String(h.s5xx) }] } },
      { name: 'nav.http.latency.avg', unit: 'ms', gauge: { dataPoints: [{ timeUnixNano: now, asDouble: reqs ? Number(h.lat) / reqs : 0 }] } },
      { name: 'nav.http.bytes_out', unit: 'By', gauge: { dataPoints: [{ timeUnixNano: now, asInt: String(h.bytes) }] } },
    );
  }
  return {
    resourceMetrics: [...byService.entries()].map(([id, b]) => ({
      resource: { attributes: attrs({ 'service.name': b.name, 'nav.service.id': id, 'nav.service.slug': b.slug, 'host.name': os.hostname() }) },
      scopeMetrics: [{ scope: { name: 'nav', version: '0.1.0' }, metrics: b.metrics }],
    })),
  };
}

export async function pushMetrics(s: Row): Promise<void> {
  const payload = await otlpPayload(s.workspace_id);
  if (!payload) return;
  try {
    const url = new URL('/v1/metrics', (await assertPublicUrl(s.endpoint)).href.replace(/\/v1\/metrics\/?$/, '/'));
    const headers = s.headers_enc ? (JSON.parse(decrypt(s.headers_enc)) as Record<string, string>) : {};
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => {});
    await q('UPDATE metrics_streams SET last_error = $2::text, last_sent_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sent_at END WHERE workspace_id = $1', [s.workspace_id, res.ok ? null : `HTTP ${res.status}`]);
  } catch (err) {
    await q('UPDATE metrics_streams SET last_error = $2 WHERE workspace_id = $1', [s.workspace_id, (err as Error).message.slice(0, 300)]);
  }
}

export function startMetricsStreams(): void {
  setInterval(async () => {
    for (const s of await q('SELECT * FROM metrics_streams WHERE enabled').catch(() => [] as Row[])) await pushMetrics(s);
  }, 60_000).unref();
}
