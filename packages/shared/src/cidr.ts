// CIDR allow lists for IPv4 and IPv6, checked against a connecting client's address (edge inbound IP rules, Key Value TLS proxy).
import net from 'node:net';

export interface Cidr { bytes: Buffer; prefix: number }

function toBytes(ip: string): Buffer | null {
  let v = ip.trim();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
  if (net.isIPv4(v)) return Buffer.from(v.split('.').map(Number));
  if (!net.isIPv6(v)) return null;
  const [head, tail = ''] = v.split('::');
  const parse = (s: string) => (s ? s.split(':') : []).flatMap((g) => {
    if (net.isIPv4(g)) { const b = g.split('.').map(Number); return [(b[0] << 8) | b[1], (b[2] << 8) | b[3]]; }
    return [parseInt(g, 16)];
  });
  const h = parse(head);
  const t = parse(tail);
  const groups = v.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill(0), ...t] : h;
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(g & 0xffff, i * 2));
  return out;
}

export function parseCidr(s: string): Cidr | null {
  const [ip, len] = s.split('/');
  const bytes = toBytes(ip);
  if (!bytes) return null;
  const max = bytes.length * 8;
  const prefix = len === undefined ? max : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

export function inCidr(ip: string, c: Cidr): boolean {
  const b = toBytes(ip);
  if (!b || b.length !== c.bytes.length) return false;
  let bits = c.prefix;
  for (let i = 0; i < b.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((b[i] & mask) !== (c.bytes[i] & mask)) return false;
  }
  return true;
}

/** No rules means everyone is allowed. */
export function ipAllowed(ip: string | undefined, rules: Cidr[]): boolean {
  if (!rules.length) return true;
  if (!ip) return false;
  return rules.some((c) => inCidr(ip, c));
}
