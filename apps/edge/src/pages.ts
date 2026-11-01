// Branded error pages served by the edge itself (no upstream involved).
import type { IncomingMessage, ServerResponse } from 'node:http';

export type PageKind =
  | 'not_found'
  | 'suspended'
  | 'maintenance'
  | 'no_upstream'
  | 'bad_gateway'
  | 'gateway_timeout'
  | 'bad_request'
  | 'uri_too_long'
  | 'headers_too_large'
  | 'method_not_allowed'
  | 'static_not_found'
  | 'range_not_satisfiable'
  | 'ip_blocked'
  | 'waking';

interface PageDef { status: number; code: string; title: string; message: string }

export const PAGES: Record<PageKind, PageDef> = {
  not_found: { status: 404, code: 'no_service', title: 'No NAV service at this address', message: 'There is no service configured for this hostname. Check the URL, or finish setting up the custom domain in your NAV dashboard.' },
  suspended: { status: 503, code: 'service_suspended', title: 'This service has been suspended', message: 'The owner of this service has suspended it. If you own it, resume it from the NAV dashboard.' },
  maintenance: { status: 503, code: 'maintenance', title: 'Down for maintenance', message: 'This service is undergoing scheduled maintenance. Please check back shortly.' },
  no_upstream: { status: 503, code: 'no_healthy_instances', title: 'Service is starting', message: 'No healthy instances are available right now. If a deploy is in progress, this page will be replaced as soon as the service is live.' },
  waking: { status: 503, code: 'service_waking', title: 'Waking up — retry shortly', message: 'This free instance spun down after a period without traffic and is starting again. Retry in a few seconds.' },
  bad_gateway: { status: 502, code: 'bad_gateway', title: 'Bad gateway', message: 'The service did not return a valid response. Please try again in a moment.' },
  gateway_timeout: { status: 504, code: 'gateway_timeout', title: 'Gateway timeout', message: 'The service took too long to respond.' },
  bad_request: { status: 400, code: 'bad_request', title: 'Bad request', message: 'The request could not be understood by the edge.' },
  uri_too_long: { status: 414, code: 'uri_too_long', title: 'URI too long', message: 'The request URL exceeds the maximum allowed length.' },
  headers_too_large: { status: 431, code: 'headers_too_large', title: 'Request headers too large', message: 'The request headers exceed the maximum allowed size.' },
  ip_blocked: { status: 403, code: 'ip_not_allowed', title: 'Access denied', message: 'This service only accepts requests from approved IP addresses.' },
  method_not_allowed: { status: 405, code: 'method_not_allowed', title: 'Method not allowed', message: 'Static sites only accept GET and HEAD requests.' },
  static_not_found: { status: 404, code: 'not_found', title: 'Page not found', message: 'The page you are looking for does not exist.' },
  range_not_satisfiable: { status: 416, code: 'range_not_satisfiable', title: 'Range not satisfiable', message: 'The requested byte range is outside the file.' },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderHtml(kind: PageKind, requestId?: string): string {
  const p = PAGES[kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(p.title)} · NAV</title></head>` +
    `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e6e8eb;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif">` +
    `<main style="max-width:520px;padding:32px 24px">` +
    `<div style="font-weight:800;letter-spacing:.32em;font-size:13px;color:#8b93a1;margin-bottom:28px">N<span style="color:#7c9cff">A</span>V</div>` +
    `<div style="font-size:13px;color:#7c9cff;font-variant-numeric:tabular-nums;margin-bottom:8px">${p.status}</div>` +
    `<h1 style="margin:0 0 12px;font-size:24px;font-weight:650;line-height:1.3">${esc(p.title)}</h1>` +
    `<p style="margin:0;color:#a8afbb">${esc(p.message)}</p>` +
    (requestId ? `<p style="margin:28px 0 0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#5d6572">request ${esc(requestId)}</p>` : '') +
    `</main></body></html>`;
}

export function wantsJson(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

export interface PageBody { status: number; contentType: string; body: string }

export function pageBody(kind: PageKind, json: boolean, requestId?: string): PageBody {
  const p = PAGES[kind];
  if (json) {
    return {
      status: p.status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: { code: p.code, message: p.title }, requestId }),
    };
  }
  return { status: p.status, contentType: 'text/html; charset=utf-8', body: renderHtml(kind, requestId) };
}

export function sendPage(
  req: IncomingMessage,
  res: ServerResponse,
  kind: PageKind,
  extraHeaders: Record<string, string> = {},
  requestId?: string,
): void {
  if (res.headersSent) { res.destroy(); return; }
  const b = pageBody(kind, wantsJson(req), requestId);
  const headers: Record<string, string | number> = {
    'content-type': b.contentType,
    'content-length': Buffer.byteLength(b.body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  };
  if (b.status === 503 && headers['retry-after'] === undefined) headers['retry-after'] = '5';
  res.writeHead(b.status, headers);
  res.end(req.method === 'HEAD' ? undefined : b.body);
}

/** Raw HTTP/1.1 response for sockets that never became a ServerResponse (upgrade / clientError). */
export function rawPage(kind: PageKind, requestId?: string): string {
  const b = pageBody(kind, false, requestId);
  return `HTTP/1.1 ${b.status} ${PAGES[kind].title.replace(/[^\x20-\x7e]/g, '')}\r\n` +
    `content-type: ${b.contentType}\r\ncontent-length: ${Buffer.byteLength(b.body)}\r\ncache-control: no-store\r\n` +
    `${kind === 'waking' ? 'retry-after: 10\r\n' : ''}connection: close\r\n\r\n${b.body}`;
}
