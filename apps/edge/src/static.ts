// Static site serving: safe path resolution, redirects/rewrites, headers, ETag/304,
// gzip/brotli (streamed, LRU-cached), HEAD and single-range requests.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { matchPath, matchRules } from './match.ts';
import { sendPage } from './pages.ts';
import type { Route } from './routes.ts';

export const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.wasm': 'application/wasm',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime', '.ics': 'text/calendar', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain',
  '.rss': 'application/rss+xml', '.atom': 'application/atom+xml', '.jsonld': 'application/ld+json',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function isTextual(type: string): boolean {
  return type.startsWith('text/') || type === 'image/svg+xml' || type === 'application/wasm' ||
    /^application\/(json|javascript|xml|manifest\+json|rss\+xml|atom\+xml|ld\+json)$/.test(type) ||
    type === 'application/vnd.ms-fontobject' || type === 'font/ttf' || type === 'font/otf';
}

function contentType(type: string): string {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/manifest+json' ||
    type === 'image/svg+xml' || type === 'application/xml' ? `${type}; charset=utf-8` : type;
}

/** `name.abc123.js`, `index-BkQ3x9_a.js`, `chunk.8f3a2c1d.css` → immutable. */
export function isHashedAsset(file: string): boolean {
  const base = path.basename(file);
  const m = /[.-]([A-Za-z0-9_]{6,32})\.[A-Za-z0-9]+$/.exec(base);
  if (!m) return false;
  const tok = m[1];
  if (/^[0-9a-f]{8,}$/.test(tok)) return true;
  return /\d/.test(tok) && /[A-Za-z]/.test(tok);
}

/**
 * Resolve a decoded URL path to an absolute file path inside `root`, or null when unsafe:
 * null bytes, `..` escapes, backslashes/drive letters, and dotfiles (except `.well-known`).
 */
export function resolveSafe(root: string, urlPath: string): string | null {
  if (typeof urlPath !== 'string' || urlPath.includes('\0')) return null;
  if (urlPath.includes('\\')) return null;
  const segments = urlPath.split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s === '..' || s === '.') return null;
    if (s.includes(':')) return null; // Windows drive letters / alternate data streams
    if (s.startsWith('.') && !(i === 0 && s === '.well-known')) return null;
  }
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, ...segments);
  const rel = path.relative(absRoot, target);
  if (rel === '') return absRoot;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/** Decode a raw URL pathname; null on malformed escapes or null bytes. */
export function decodePath(raw: string): string | null {
  try {
    const p = decodeURIComponent(raw);
    return p.includes('\0') ? null : p;
  } catch {
    return null;
  }
}

// --- compressed output LRU -----------------------------------------------------------------------

class Lru {
  private map = new Map<string, Buffer>();
  private bytes = 0;
  private max: number;
  constructor(maxBytes: number) { this.max = maxBytes; }
  get(k: string): Buffer | undefined {
    const v = this.map.get(k);
    if (v) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: Buffer): void {
    if (v.length > this.max / 8) return;
    const old = this.map.get(k);
    if (old) { this.bytes -= old.length; this.map.delete(k); }
    this.map.set(k, v);
    this.bytes += v.length;
    while (this.bytes > this.max) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.length;
      this.map.delete(first);
    }
  }
}

const compressedCache = new Lru(Number(process.env.NAV_EDGE_STATIC_CACHE_BYTES ?? 64 * 1024 * 1024));

function pickEncoding(accept: string | undefined): 'br' | 'gzip' | null {
  if (!accept) return null;
  const q = new Map<string, number>();
  for (const part of accept.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    let qv = 1;
    for (const p of params) { const m = /^\s*q=([0-9.]+)/.exec(p); if (m) qv = Number(m[1]); }
    q.set(name.trim(), qv);
  }
  const star = q.get('*');
  const val = (n: string) => q.get(n) ?? star ?? 0;
  if (val('br') > 0) return 'br';
  if (val('gzip') > 0) return 'gzip';
  return null;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '').replace(/-(br|gz)"$/, '"');
  const want = strip(etag);
  return header.split(',').some((t) => strip(t) === want);
}

function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multiple or unknown units -> ignore, serve full
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// --- request handling ----------------------------------------------------------------------------

export interface StaticContext {
  requestId: string;
  /** Proxy the request to an absolute http(s) URL (rewrite destination). */
  proxyUrl: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
}

function applyHeaders(res: ServerResponse, route: Route, urlPath: string): void {
  for (const h of route.staticHeaders) {
    if (!h || typeof h.name !== 'string' || typeof h.value !== 'string' || typeof h.path !== 'string') continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name) || /[\r\n\0]/.test(h.value)) continue;
    if (matchPath(h.path, urlPath)) {
      try { res.setHeader(h.name, h.value); } catch { /* invalid header, ignore */ }
    }
  }
}

function statFile(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

interface Resolved { file: string; stat: fs.Stats }

/** Look up a file for a decoded path: exact file, dir/index.html, or `path.html`. */
export function lookupFile(root: string, urlPath: string): Resolved | { redirect: string } | null {
  const abs = resolveSafe(root, urlPath);
  if (!abs) return null;
  const st = statFile(abs);
  if (st?.isFile()) return { file: abs, stat: st };
  if (st?.isDirectory()) {
    const idx = path.join(abs, 'index.html');
    const ist = statFile(idx);
    if (ist?.isFile()) {
      if (!urlPath.endsWith('/')) return { redirect: `${urlPath}/` };
      return { file: idx, stat: ist };
    }
    return null;
  }
  if (!path.extname(abs) && !urlPath.endsWith('/')) {
    const html = `${abs}.html`;
    const hst = statFile(html);
    if (hst?.isFile()) return { file: html, stat: hst };
  }
  return null;
}

function encodePathForLocation(p: string): string {
  return p.split('/').map((s) => encodeURIComponent(s)).join('/');
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, route: Route, ctx: StaticContext): void {
  const root = route.artifact?.kind === 'dir' && typeof route.artifact.path === 'string' ? route.artifact.path : null;
  const rawUrl = req.url ?? '/';
  const qIdx = rawUrl.indexOf('?');
  const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
  if (!rawPath.startsWith('/')) { sendPage(req, res, 'bad_request', {}, ctx.requestId); return; }
  let urlPath = decodePath(rawPath);
  if (urlPath === null) { sendPage(req, res, 'bad_request', {}, ctx.requestId); return; }
  const originalPath = urlPath;

  // Rules evaluated in order before file lookup.
  const hit = matchRules(route.staticRoutes, rawPath);
  if (hit) {
    const dest = hit.destination;
    if (hit.rule.type === 'redirect') {
      const location = dest.includes('?') || !query ? dest : dest + query;
      applyHeaders(res, route, originalPath);
      res.writeHead(301, { location, 'content-length': 0, 'cache-control': 'public, max-age=0, must-revalidate' });
      res.end();
      return;
    }
    if (/^https?:\/\//i.test(dest)) {
      let target: URL;
      try { target = new URL(dest); } catch { sendPage(req, res, 'bad_gateway', {}, ctx.requestId); return; }
      if (!target.search && query) target.search = query;
      ctx.proxyUrl(req, res, target);
      return;
    }
    // Local rewrite. An existing file at the requested path wins (so `/* -> /index.html` SPA
    // fallbacks don't swallow real assets).
    const existing = root ? lookupFile(root, urlPath) : null;
    if (!existing) {
      const dq = dest.indexOf('?');
      const decoded = decodePath(dq >= 0 ? dest.slice(0, dq) : dest);
      if (decoded === null) { sendPage(req, res, 'bad_request', {}, ctx.requestId); return; }
      urlPath = decoded.startsWith('/') ? decoded : `/${decoded}`;
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    sendPage(req, res, 'method_not_allowed', {}, ctx.requestId);
    return;
  }
  if (!root) { sendPage(req, res, 'no_upstream', {}, ctx.requestId); return; }

  const found = lookupFile(root, urlPath);
  if (found && 'redirect' in found) {
    res.writeHead(301, { location: encodePathForLocation(found.redirect) + query, 'content-length': 0 });
    res.end();
    return;
  }
  applyHeaders(res, route, originalPath);
  if (!found) {
    const nf = statFile(path.join(root, '404.html'));
    if (nf?.isFile()) {
      sendFile(req, res, path.join(root, '404.html'), nf, 404);
      return;
    }
    sendPage(req, res, 'static_not_found', {}, ctx.requestId);
    return;
  }
  sendFile(req, res, found.file, found.stat, 200);
}

export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, stat: fs.Stats, status: number): void {
  const type = mimeFor(file);
  const baseTag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const isHtml = type === 'text/html';
  const cacheControl = status !== 200 ? 'no-cache'
    : isHashedAsset(file) && !isHtml ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate';
  const compressible = isTextual(type) && stat.size >= 256;
  const enc = compressible ? pickEncoding(req.headers['accept-encoding'] as string | undefined) : null;
  const rangeHeader = req.headers.range;
  const useRange = status === 200 && typeof rangeHeader === 'string' &&
    (!req.headers['if-range'] || req.headers['if-range'] === baseTag);
  const range = useRange ? parseRange(rangeHeader, stat.size) : null;
  const encoding = range ? null : enc; // ranges are served from the identity representation
  const etag = encoding ? baseTag.replace(/"$/, encoding === 'br' ? '-br"' : '-gz"') : baseTag;

  res.setHeader('content-type', contentType(type));
  res.setHeader('cache-control', cacheControl);
  res.setHeader('x-content-type-options', 'nosniff');
  if (status === 200) {
    res.setHeader('etag', etag);
    res.setHeader('last-modified', stat.mtime.toUTCString());
    res.setHeader('accept-ranges', 'bytes');
  }
  if (compressible) res.setHeader('vary', 'Accept-Encoding');

  if (status === 200 && etagMatches(req.headers['if-none-match'] as string | undefined, etag)) {
    res.removeHeader('content-type');
    res.writeHead(304);
    res.end();
    return;
  }

  const head = req.method === 'HEAD';
  if (range === 'invalid') {
    res.setHeader('content-range', `bytes */${stat.size}`);
    res.removeHeader('etag');
    res.writeHead(416, { 'content-length': 0 });
    res.end();
    return;
  }
  if (range) {
    const len = range.end - range.start + 1;
    res.writeHead(206, { 'content-range': `bytes ${range.start}-${range.end}/${stat.size}`, 'content-length': len });
    if (head) { res.end(); return; }
    pipeFile(fs.createReadStream(file, { start: range.start, end: range.end }), res);
    return;
  }

  if (!encoding) {
    res.writeHead(status, { 'content-length': stat.size });
    if (head) { res.end(); return; }
    pipeFile(fs.createReadStream(file), res);
    return;
  }

  res.setHeader('content-encoding', encoding);
  const cacheKey = `${file}|${etag}`;
  const cached = compressedCache.get(cacheKey);
  if (cached) {
    res.writeHead(status, { 'content-length': cached.length });
    res.end(head ? undefined : cached);
    return;
  }
  res.writeHead(status);
  if (head) { res.end(); return; }
  const z = encoding === 'br'
    ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stat.size } })
    : zlib.createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  let total = 0;
  let cacheable = stat.size <= 4 * 1024 * 1024;
  z.on('data', (c: Buffer) => {
    if (!cacheable) return;
    total += c.length;
    if (total > 4 * 1024 * 1024) { cacheable = false; chunks.length = 0; } else chunks.push(c);
  });
  z.on('end', () => { if (cacheable) compressedCache.set(cacheKey, Buffer.concat(chunks)); });
  const src = fs.createReadStream(file);
  src.on('error', () => { z.destroy(); res.destroy(); });
  z.on('error', () => res.destroy());
  res.on('close', () => { if (!res.writableFinished) { src.destroy(); z.destroy(); } });
  src.pipe(z).pipe(res);
}

function pipeFile(src: fs.ReadStream, res: ServerResponse): void {
  src.on('error', () => res.destroy());
  res.on('close', () => { if (!res.writableFinished) src.destroy(); });
  src.pipe(res);
}
