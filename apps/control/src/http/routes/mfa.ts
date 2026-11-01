// Two-factor authentication: authenticator-app codes (TOTP) with single-use recovery codes. A sign-in by
// password or OAuth for a user with 2FA leaves a short-lived challenge in an httpOnly cookie; the session is only
// created once a code for it is accepted.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt, encrypt, sha256 } from '@nav/shared/crypto';
import { one, q, type Row } from '../../db/pool.ts';
import { HttpError } from '../../lib/core.ts';
import * as totp from '../../lib/totp.ts';
import { createSession, requireUser, verifyPassword } from '../auth.ts';

const MFA_COOKIE = 'nav_mfa';
const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 6;

/**
 * Finishes a first-factor sign-in: creates the session, or, when the user has 2FA, a challenge for the second
 * factor. Returns whether a code is still required.
 */
export async function beginSession(req: FastifyRequest, reply: FastifyReply, userId: string, next: string | null = null): Promise<'session' | 'mfa'> {
  const u = await one('SELECT totp_enabled_at FROM users WHERE id = $1', [userId]);
  if (!u?.totp_enabled_at) {
    await createSession(reply, req, userId);
    return 'session';
  }
  const token = randomBytes(32).toString('base64url');
  await q('DELETE FROM mfa_challenges WHERE user_id = $1 OR expires_at < now()', [userId]);
  await q('INSERT INTO mfa_challenges (id, user_id, next, expires_at) VALUES ($1,$2,$3,$4)', [sha256(token), userId, next, new Date(Date.now() + CHALLENGE_TTL_MS)]);
  reply.setCookie(MFA_COOKIE, token, { path: '/api/v1/auth', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: CHALLENGE_TTL_MS / 1000 });
  return 'mfa';
}

/** Accepts an authenticator code (each time step once) or an unused recovery code, consuming the latter. */
async function checkSecondFactor(user: Row, code: string): Promise<'totp' | 'recovery' | null> {
  const c = code.trim().toLowerCase();
  if (/^\d{3}\s?\d{3}$/.test(c) && user.totp_secret_enc) {
    const counter = totp.verify(decrypt(user.totp_secret_enc), c);
    if (counter === null || (user.totp_last_counter !== null && counter <= Number(user.totp_last_counter))) return null;
    await q('UPDATE users SET totp_last_counter = $2 WHERE id = $1', [user.id, counter]);
    return 'totp';
  }
  const hash = sha256(c.replace(/\s+/g, ''));
  const left = (user.recovery_codes as string[]).filter((h) => h !== hash);
  if (left.length === (user.recovery_codes as string[]).length) return null;
  await q('UPDATE users SET recovery_codes = $2 WHERE id = $1', [user.id, JSON.stringify(left)]);
  return 'recovery';
}

const Code = z.object({ code: z.string().trim().min(6).max(20) });

export async function mfaRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // Second step of sign-in.
  app.post('/auth/login/mfa', strict, async (req, reply) => {
    const { code } = Code.parse(req.body);
    const token = req.cookies[MFA_COOKIE];
    const ch = token ? await one('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1 AND expires_at > now() RETURNING *', [sha256(token)]) : null;
    if (!ch || ch.attempts > MAX_ATTEMPTS) {
      if (ch) await q('DELETE FROM mfa_challenges WHERE id = $1', [ch.id]);
      throw new HttpError(401, 'mfa_expired', 'your sign-in expired — start again');
    }
    const user = (await one('SELECT * FROM users WHERE id = $1', [ch.user_id]))!;
    const how = await checkSecondFactor(user, code);
    if (!how) throw new HttpError(401, 'invalid_code', 'that code is not valid');
    await q('DELETE FROM mfa_challenges WHERE id = $1', [ch.id]);
    reply.clearCookie(MFA_COOKIE, { path: '/api/v1/auth' });
    await createSession(reply, req, user.id);
    return { ok: true, next: ch.next ?? '/app', usedRecoveryCode: how === 'recovery', recoveryCodesLeft: how === 'recovery' ? (user.recovery_codes as string[]).length - 1 : undefined };
  });

  // Enrolment: a pending secret, confirmed by a first code.
  app.post('/auth/mfa/setup', async (req) => {
    const u = requireUser(req);
    const user = (await one('SELECT * FROM users WHERE id = $1', [u.id]))!;
    if (user.totp_enabled_at) throw new HttpError(409, 'mfa_enabled', 'two-factor authentication is already on');
    const secret = totp.newSecret();
    await q('UPDATE users SET totp_pending_enc = $2 WHERE id = $1', [u.id, encrypt(secret)]);
    return { secret, otpauthUrl: totp.otpauthUrl(secret, user.email) };
  });

  app.post('/auth/mfa/enable', strict, async (req) => {
    const u = requireUser(req);
    const { code } = Code.parse(req.body);
    const user = (await one('SELECT * FROM users WHERE id = $1', [u.id]))!;
    if (!user.totp_pending_enc) throw new HttpError(400, 'no_setup', 'start two-factor setup first');
    const secret = decrypt(user.totp_pending_enc);
    const counter = totp.verify(secret, code);
    if (counter === null) throw new HttpError(400, 'invalid_code', 'that code is not valid — check the time on your device');
    const codes = totp.recoveryCodes();
    await q(
      `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_counter = $2,
         recovery_codes = $3 WHERE id = $1`,
      [u.id, counter, JSON.stringify(codes.map(sha256))],
    );
    // Other sessions were established without the second factor.
    await q('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, sha256(req.cookies.nav_session ?? '')]);
    return { enabled: true, recoveryCodes: codes };
  });

  /** Turning 2FA off or regenerating codes needs a current code (or the password for accounts that have one). */
  const confirm = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const body = z.object({ code: z.string().trim().max(20).optional(), password: z.string().max(256).optional() }).parse(req.body);
    const user = (await one('SELECT * FROM users WHERE id = $1', [u.id]))!;
    if (!user.totp_enabled_at) throw new HttpError(400, 'mfa_disabled', 'two-factor authentication is off');
    const ok = (body.code && (await checkSecondFactor(user, body.code))) || (body.password && user.password_hash && (await verifyPassword(body.password, user.password_hash)));
    if (!ok) throw new HttpError(401, 'invalid_code', 'enter a valid code from your authenticator app');
    return user;
  };

  app.post('/auth/mfa/disable', strict, async (req) => {
    const user = await confirm(req);
    await q("UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_counter = NULL, recovery_codes = '[]' WHERE id = $1", [user.id]);
    return { enabled: false };
  });

  app.post('/auth/mfa/recovery-codes', strict, async (req) => {
    const user = await confirm(req);
    const codes = totp.recoveryCodes();
    await q('UPDATE users SET recovery_codes = $2 WHERE id = $1', [user.id, JSON.stringify(codes.map(sha256))]);
    return { recoveryCodes: codes };
  });
}
