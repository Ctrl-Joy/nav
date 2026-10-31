// Environment variables, secret files and env groups (all encrypted at rest).
import { decrypt, encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import type { EnvVar, SecretFile } from '@nav/shared';
import { q, type Client } from '../db/pool.ts';
import { badRequest } from './core.ts';

type Owner = 'service' | 'group';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FILE_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const RESERVED = new Set(['PORT', 'NAV', 'NAV_SERVICE_ID', 'NAV_INSTANCE_ID']);

export function validateEnvVars(vars: EnvVar[]): void {
  const seen = new Set<string>();
  for (const v of vars) {
    if (!KEY_RE.test(v.key)) throw badRequest(`invalid environment variable name "${v.key}"`);
    if (seen.has(v.key)) throw badRequest(`duplicate environment variable "${v.key}"`);
    if (v.value.length > 64 * 1024) throw badRequest(`value of ${v.key} exceeds 64KB`);
    seen.add(v.key);
  }
}

export function validateSecretFiles(files: SecretFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    if (!FILE_RE.test(f.filename) || f.filename.startsWith('.')) throw badRequest(`invalid secret file name "${f.filename}"`);
    if (seen.has(f.filename)) throw badRequest(`duplicate secret file "${f.filename}"`);
    if (f.content.length > 512 * 1024) throw badRequest(`secret file ${f.filename} exceeds 512KB`);
    seen.add(f.filename);
  }
}

export async function listEnv(owner: Owner, ownerId: string): Promise<EnvVar[]> {
  const rows = await q('SELECT key, value_enc FROM env_vars WHERE owner_type = $1 AND owner_id = $2 ORDER BY key', [owner, ownerId]);
  return rows.map((r) => ({ key: r.key, value: decrypt(r.value_enc) }));
}

export async function listFiles(owner: Owner, ownerId: string): Promise<SecretFile[]> {
  const rows = await q('SELECT filename, content_enc FROM secret_files WHERE owner_type = $1 AND owner_id = $2 ORDER BY filename', [owner, ownerId]);
  return rows.map((r) => ({ filename: r.filename, content: decrypt(r.content_enc) }));
}

export async function replaceEnv(c: Client, owner: Owner, ownerId: string, vars: EnvVar[]): Promise<void> {
  validateEnvVars(vars);
  await c.query('DELETE FROM env_vars WHERE owner_type = $1 AND owner_id = $2', [owner, ownerId]);
  for (const v of vars) {
    await c.query('INSERT INTO env_vars (id, owner_type, owner_id, key, value_enc) VALUES ($1,$2,$3,$4,$5)', [id('env'), owner, ownerId, v.key, encrypt(v.value)]);
  }
}

export async function patchEnv(c: Client, owner: Owner, ownerId: string, set: EnvVar[], remove: string[]): Promise<void> {
  validateEnvVars(set);
  for (const v of set) {
    await c.query(
      `INSERT INTO env_vars (id, owner_type, owner_id, key, value_enc) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_type, owner_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
      [id('env'), owner, ownerId, v.key, encrypt(v.value)],
    );
  }
  if (remove.length) await c.query('DELETE FROM env_vars WHERE owner_type = $1 AND owner_id = $2 AND key = ANY($3)', [owner, ownerId, remove]);
}

export async function replaceFiles(c: Client, owner: Owner, ownerId: string, files: SecretFile[]): Promise<void> {
  validateSecretFiles(files);
  await c.query('DELETE FROM secret_files WHERE owner_type = $1 AND owner_id = $2', [owner, ownerId]);
  for (const f of files) {
    await c.query('INSERT INTO secret_files (id, owner_type, owner_id, filename, content_enc) VALUES ($1,$2,$3,$4,$5)', [id('sf'), owner, ownerId, f.filename, encrypt(f.content)]);
  }
}

/** Effective user-defined env for a service: linked groups (in name order) overridden by service vars. */
export async function resolveServiceEnv(serviceId: string): Promise<{ env: Record<string, string>; files: SecretFile[] }> {
  const groups = await q(
    'SELECT g.id FROM service_env_groups sg JOIN env_groups g ON g.id = sg.group_id WHERE sg.service_id = $1 ORDER BY g.name',
    [serviceId],
  );
  const env: Record<string, string> = {};
  const files = new Map<string, string>();
  for (const g of groups) {
    for (const v of await listEnv('group', g.id)) env[v.key] = v.value;
    for (const f of await listFiles('group', g.id)) files.set(f.filename, f.content);
  }
  for (const v of await listEnv('service', serviceId)) env[v.key] = v.value;
  for (const f of await listFiles('service', serviceId)) files.set(f.filename, f.content);
  return { env, files: [...files].map(([filename, content]) => ({ filename, content })) };
}

export function isReserved(key: string): boolean {
  return RESERVED.has(key);
}
