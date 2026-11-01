// Guards for URLs and hosts users point NAV at (webhooks, log streams): in production they must resolve to public
// addresses, so NAV cannot be used to reach its own private network or a cloud metadata service. A host is
// resolved once, every address it resolves to is checked, and the connection is then pinned to the checked
// address (publicFetch / connectTarget), so a second DNS answer (rebinding) cannot redirect it.
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from 'undici';
import { config } from '@nav/shared/config';
import { HttpError } from './core.ts';

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  // ::/96 covers :: and ::1 and the deprecated IPv4-compatible form; ::ffff:0:0/96 is checked as IPv4 below.
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(a, p, 'ipv6');

/** The 16 bytes of an IPv6 address in any textual form (compressed, expanded, with a dotted IPv4 tail or a zone). */
function ipv6Bytes(ip: string): Uint8Array | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!net.isIPv4(tail[1])) return null;
    const o = tail[1].split('.').map(Number);
    s = `${s.slice(0, -tail[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const v = Number.parseInt(groups[i], 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

/**
 * True for every address NAV must not connect to on a user's behalf: loopback, private, link-local, CGNAT,
 * benchmarking, multicast and reserved ranges, and IPv6 forms that embed or translate to IPv4 (mapped, compatible,
 * NAT64, 6to4, Teredo). Anything that does not parse as an IP address counts as private.
 */
export function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  const b = net.isIPv6(ip.replace(/%.*$/, '')) ? ipv6Bytes(ip) : null;
  if (!b) return true;
  // ::ffff:a.b.c.d (IPv4-mapped): the IPv4 address decides.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return blocked.check(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`, 'ipv4');
  const canonical = Array.from({ length: 8 }, (_, i) => ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16)).join(':');
  return blocked.check(canonical, 'ipv6');
}

export interface PublicAddress { address: string; family: 4 | 6 }
type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Resolves `host` once and checks every address. Returns the address to connect to, or null when private targets
 * are allowed (development: connect normally).
 */
export async function resolvePublicHost(host: string, resolve: Resolver = defaultResolver): Promise<PublicAddress | null> {
  if (config.allowPrivateTargets) return null;
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h, family: net.isIP(h) }] : await resolve(h).catch(() => []);
  if (!addrs.length) throw new HttpError(400, 'unresolvable', `${host} does not resolve`);
  if (addrs.some((a) => isPrivate(a.address))) throw new HttpError(400, 'private_target', `${host} resolves to a private address`);
  return { address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 };
}

/** Throws unless `host` resolves only to public addresses (always passes when private targets are allowed). */
export async function assertPublicHost(host: string): Promise<void> {
  await resolvePublicHost(host);
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'bad_url', 'not a valid URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && config.allowPrivateTargets)) throw new HttpError(400, 'bad_url', 'the URL must use https');
  if (u.username || u.password) throw new HttpError(400, 'bad_url', 'credentials in the URL are not allowed');
  return u;
}

/** Accepts https URLs (plain http only when private targets are allowed, i.e. development) to public hosts. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = checkUrl(raw);
  await resolvePublicHost(u.hostname);
  return u;
}

/** A net/tls `lookup` that always answers with one pre-validated address, whatever name is asked for. */
export function pinnedLookup(pin: PublicAddress): LookupFunction {
  return ((_host: string, opts: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
    const callback = typeof opts === 'function' ? (opts as (...args: unknown[]) => void) : cb;
    if (typeof opts === 'object' && opts?.all) callback(null, [{ address: pin.address, family: pin.family }]);
    else callback(null, pin.address, pin.family);
  }) as unknown as LookupFunction;
}

/** An undici dispatcher whose connections all go to `pin` (TLS still verifies the URL's hostname). */
export function pinnedAgent(pin: PublicAddress): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(pin) } });
}

/**
 * fetch() to a user-supplied URL: validated with assertPublicUrl, connected to the address that was validated
 * (never re-resolved), and never following redirects. The caller should consume or cancel the body.
 */
export async function publicFetch(raw: string, init: UndiciRequestInit = {}): Promise<UndiciResponse> {
  const u = checkUrl(raw);
  const pin = await resolvePublicHost(u.hostname);
  const dispatcher = pin ? pinnedAgent(pin) : undefined;
  try {
    return await undiciFetch(u, { ...init, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) });
  } finally {
    // close() lets the response body finish, then releases the connection.
    void dispatcher?.close().catch(() => {});
  }
}
