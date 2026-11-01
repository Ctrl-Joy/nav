// Guards for URLs and hosts users point NAV at (webhooks, log streams): in production they must resolve to public
// addresses, so NAV cannot be used to reach its own private network or a cloud metadata service.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { config } from '@nav/shared/config';
import { HttpError } from './core.ts';

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Throws unless `host` resolves only to public addresses (always passes when private targets are allowed). */
export async function assertPublicHost(host: string): Promise<void> {
  if (config.allowPrivateTargets) return;
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, 'unresolvable', `${host} does not resolve`);
  if (addrs.some((a) => isPrivate(a.address))) throw new HttpError(400, 'private_target', `${host} resolves to a private address`);
}

/** Accepts https URLs (plain http only when private targets are allowed, i.e. development) to public hosts. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'bad_url', 'not a valid URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && config.allowPrivateTargets)) throw new HttpError(400, 'bad_url', 'the URL must use https');
  if (u.username || u.password) throw new HttpError(400, 'bad_url', 'credentials in the URL are not allowed');
  await assertPublicHost(u.hostname.replace(/^\[|\]$/g, ''));
  return u;
}
