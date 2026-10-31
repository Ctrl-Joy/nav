import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish base32, no ambiguous chars

export function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** Prefixed resource id, e.g. id('srv') -> "srv_d4k9x2m7q1v8n3p5" */
export function id(prefix: string): string {
  return `${prefix}_${randomString(18)}`;
}
