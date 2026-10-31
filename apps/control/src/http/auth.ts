import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import type { Role } from '@nav/shared';
import { one, q } from '../db/pool.ts';
import { HttpError, forbidden, notFound } from '../lib/core.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'nav_session';
const SESSION_TTL_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

export async function createSession(reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await q('INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)', [
    sha256(token), userId, expires, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300),
  ]);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    expires,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await q('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export interface AuthUser { id: string; email: string; name: string }

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    authKind: 'session' | 'api_key' | null;
  }
}

/** Resolves the caller from a Bearer API key or the session cookie. Runs on every request. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  req.user = null;
  req.authKind = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    const row = await one(
      'UPDATE api_keys k SET last_used_at = now() FROM users u WHERE k.token_hash = $1 AND u.id = k.user_id RETURNING u.id, u.email, u.name',
      [sha256(token)],
    );
    if (!row) throw new HttpError(401, 'unauthorized', 'invalid API key');
    req.user = { id: row.id, email: row.email, name: row.name };
    req.authKind = 'api_key';
    return;
  }
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const row = await one(
    'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()',
    [sha256(token)],
  );
  if (row) {
    req.user = { id: row.id, email: row.email, name: row.name };
    req.authKind = 'session';
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, 'unauthorized', 'authentication required');
  return req.user;
}

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** Ensures the caller is a member of the workspace with at least `min` role; returns their role. */
export async function workspaceRole(req: FastifyRequest, workspaceId: string, min: Role = 'viewer'): Promise<Role> {
  const user = requireUser(req);
  const row = await one<{ role: Role }>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, user.id]);
  if (!row) throw notFound('workspace');
  if (!atLeast(row.role, min)) throw forbidden();
  return row.role;
}

/** Loads a workspace-scoped row (services, databases, ...) and checks membership. 404 hides existence. */
export async function scoped(req: FastifyRequest, table: 'services' | 'databases' | 'env_groups' | 'blueprints' | 'projects', rowId: string, min: Role = 'viewer') {
  const row = await one(`SELECT * FROM ${table} WHERE id = $1`, [rowId]);
  if (!row) throw notFound(table.replace(/s$/, '').replace('_', ' '));
  const role = await workspaceRole(req, row.workspace_id, min).catch((err) => {
    throw err.status === 403 ? err : notFound(table.replace(/s$/, ''));
  });
  return { row, role };
}

export function newApiKey(): { token: string; prefix: string; hash: string; id: string } {
  const token = `nav_${randomBytes(30).toString('base64url')}`;
  return { token, prefix: token.slice(0, 10), hash: sha256(token), id: id('key') };
}
