// AES-256-GCM envelope for secrets at rest. Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.NAV_MASTER_KEY;
  if (!raw) throw new Error('NAV_MASTER_KEY is not set');
  // Accept 64-hex or base64(32 bytes); anything else is stretched with SHA-256 (dev convenience).
  if (/^[0-9a-f]{64}$/i.test(raw)) cachedKey = Buffer.from(raw, 'hex');
  else {
    const b = Buffer.from(raw, 'base64');
    cachedKey = b.length === 32 ? b : createHash('sha256').update(raw).digest();
  }
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split(':');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
