import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '@nav/shared/config';
import { encrypt, sha256 } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { slugify } from '@nav/shared';
import { one, q, tx, type Client } from '../../db/pool.ts';
import { HttpError, notFound } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { githubClientId, githubOAuthEnabled, oauthExchange } from '../../lib/github.ts';
import { ensureProviderSettings, isPlatformAdmin } from '../../lib/providerSettings.ts';
import { adminRoutes } from './admin.ts';
import { PROVIDERS, authorizeUrl, callbackUrl, exchange, pkcePair, providerEnabled, type Profile, type ProviderId } from '../../lib/identity.ts';
import { SESSION_COOKIE, createSession, destroySession, effectiveRole, hashPassword, newApiKey, requireUser, verifyPassword } from '../auth.ts';
import { assertSsoNotRequired, emailDomain, orgForEmail } from '../../lib/orgs.ts';
import { beginSession } from './mfa.ts';
import { layout, sendMail } from '../../lib/mail.ts';

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(8, 'must be at least 8 characters').max(256);
const Signup = z.object({ email: Email, password: Password, name: z.string().trim().min(1).max(100).optional() });

/** "ada.lovelace@x.io" -> "Ada Lovelace": a starting display name when sign-up only asks for an email. */
function nameFromEmail(email: string): string {
  const words = email.split('@')[0].split(/[._+-]+/).filter(Boolean).slice(0, 3);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return name.slice(0, 100) || 'NAV user';
}
const Login = z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(256) });

const RESET_TTL_MS = 60 * 60_000;
const OAUTH_COOKIE = 'nav_oauth';
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

/** Workspaces the user can open: their memberships plus every workspace of orgs they own or administer. */
export async function userWorkspaces(userId: string) {
  const rows = await q(
    `SELECT w.*, m.role AS ws_role, om.role AS org_role, o.name AS org_name, COALESCE(o.require_2fa, false) AS org_2fa
     FROM workspaces w
     LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
     LEFT JOIN orgs o ON o.id = w.org_id
     LEFT JOIN org_members om ON om.org_id = w.org_id AND om.user_id = $1
     WHERE m.user_id IS NOT NULL OR om.role IN ('owner','admin')
     ORDER BY w.created_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, role: effectiveRole(r.ws_role, r.org_role)!, requireTwoFactor: r.require_2fa || r.org_2fa,
    orgId: r.org_id ?? null, orgName: r.org_name ?? null, createdAt: r.created_at,
  }));
}

export async function userOrgs(userId: string) {
  const rows = await q('SELECT o.*, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = $1 ORDER BY o.created_at', [userId]);
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, role: r.role, requireTwoFactor: r.require_2fa, createdAt: r.created_at }));
}

function userOut(r: Record<string, any>) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    githubLogin: r.github_login,
    avatarUrl: r.avatar_url,
    hasPassword: !!r.password_hash,
    emailVerified: !!r.email_verified_at,
    mfaEnabled: !!r.totp_enabled_at,
    emailNotifications: r.email_notifications ?? true,
    recoveryCodesLeft: r.totp_enabled_at ? (r.recovery_codes ?? []).length : 0,
    createdAt: r.created_at,
  };
}

/** The signed-in user as the dashboard sees it, including whether they administer this NAV instance. */
async function meOut(r: Record<string, any>) {
  return { ...userOut(r), isPlatformAdmin: await isPlatformAdmin(r.id) };
}

export async function uniqueSlug(c: Client | null, table: string, base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${randomBytes(2).toString('hex')}`;
    const sql = `SELECT 1 FROM ${table} WHERE slug = $1`;
    const hit = c ? (await c.query(sql, [candidate])).rowCount : (await q(sql, [candidate])).length;
    if (!hit) return candidate;
  }
  throw new Error('could not allocate slug');
}

/** Creates the user's personal workspace and accepts any pending invites for their email. */
async function onboardUser(c: Client, userId: string, name: string, email: string) {
  const wsId = id('ws');
  await c.query('INSERT INTO workspaces (id, name, slug) VALUES ($1,$2,$3)', [wsId, `${name.split(' ')[0]}'s Workspace`, await uniqueSlug(c, 'workspaces', name)]);
  await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [wsId, userId]);
  const invites = await c.query('UPDATE workspace_invites SET accepted_at = now() WHERE lower(email) = lower($1) AND accepted_at IS NULL RETURNING workspace_id, role', [email]);
  for (const inv of invites.rows) {
    await c.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [inv.workspace_id, userId, inv.role]);
  }
}

/** Only same-site relative paths may be used as a post-sign-in destination. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(next) && !next.includes('\\') ? next : '/app';
}

type OAuthState = { p: ProviderId; s: string; v: string; m: 'login' | 'connect'; n: string };

function readOAuthState(req: FastifyRequest, reply: FastifyReply, provider: ProviderId, state: string | undefined): OAuthState | null {
  const raw = req.cookies[OAUTH_COOKIE];
  reply.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth' });
  if (!raw || !state) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as OAuthState;
    return parsed.p === provider && parsed.s === state ? parsed : null;
  } catch {
    return null;
  }
}

function writeOAuthState(req: FastifyRequest, reply: FastifyReply, st: OAuthState) {
  reply.setCookie(OAUTH_COOKIE, Buffer.from(JSON.stringify(st)).toString('base64url'), {
    path: '/api/v1/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: 600,
  });
}

class SignInError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Resolves a provider profile to a NAV user: an existing linked identity, an existing account with the same
 * *verified* email, or a new account. Linking by email is refused when the existing account never proved it owns
 * that address, which blocks pre-registering someone else's email and waiting for them to sign in with a provider.
 */
async function resolveIdentity(provider: ProviderId, profile: Profile, connectTo: string | null): Promise<string> {
  const ident = await one('SELECT * FROM user_identities WHERE provider = $1 AND subject = $2', [provider, profile.subject]);
  let userId: string | null = ident?.user_id ?? null;

  if (connectTo) {
    if (userId && userId !== connectTo) throw new SignInError('identity_in_use');
    const other = await one('SELECT 1 FROM user_identities WHERE user_id = $1 AND provider = $2 AND subject <> $3', [connectTo, provider, profile.subject]);
    if (other) throw new SignInError('already_connected');
    userId = connectTo;
  }

  if (!userId) {
    if (!profile.email || !profile.emailVerified) throw new SignInError('unverified_email');
    const email = profile.email.toLowerCase();
    const existing = await one('SELECT id, email_verified_at FROM users WHERE email = $1', [email]);
    if (existing) {
      if (!existing.email_verified_at) throw new SignInError('email_in_use');
      if (await one('SELECT 1 FROM user_identities WHERE user_id = $1 AND provider = $2', [existing.id, provider])) throw new SignInError('already_connected');
      userId = existing.id as string;
    } else {
      const newId = id('usr');
      const name = profile.name || profile.username || email.split('@')[0];
      await tx(async (c) => {
        await c.query('INSERT INTO users (id, email, name, avatar_url, email_verified_at) VALUES ($1,$2,$3,$4, now())', [newId, email, name, profile.avatarUrl]);
        await onboardUser(c, newId, name, email);
      });
      userId = newId;
    }
  }

  await q(
    `INSERT INTO user_identities (id, user_id, provider, subject, email, username, avatar_url, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email, username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url, last_used_at = now()`,
    [id('idn'), userId, provider, profile.subject, profile.email, profile.username, profile.avatarUrl],
  );
  // A provider vouching for the account's own address also verifies it.
  if (profile.email && profile.emailVerified) {
    await q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 AND email = lower($2)', [userId, profile.email]);
  }
  await q('UPDATE users SET avatar_url = COALESCE(avatar_url, $2) WHERE id = $1', [userId, profile.avatarUrl]);
  return userId;
}

async function finishOAuth(req: FastifyRequest, reply: FastifyReply, provider: ProviderId, st: OAuthState, load: () => Promise<Profile>, after?: (userId: string) => Promise<void>) {
  const connectTo = st.m === 'connect' ? (req.user?.id ?? null) : null;
  const back = st.m === 'connect' ? '/account' : '/login';
  if (st.m === 'connect' && !connectTo) return reply.redirect(`${config.dashboardUrl}/login?error=session_expired`);
  try {
    const profile = await load();
    const userId = await resolveIdentity(provider, profile, connectTo);
    if (after) await after(userId);
    if (connectTo) return reply.redirect(`${config.dashboardUrl}/account?connected=${provider}#connections`);
    const email = (await one('SELECT email FROM users WHERE id = $1', [userId]))?.email as string;
    if ((await orgForEmail(email))?.enforce) throw new SignInError('sso_required');
    if ((await beginSession(req, reply, userId, safeNext(st.n))) === 'mfa') return reply.redirect(`${config.dashboardUrl}/login/mfa`);
    return reply.redirect(`${config.dashboardUrl}${safeNext(st.n)}`);
  } catch (err) {
    const code = err instanceof SignInError ? err.code : 'provider_error';
    if (!(err instanceof SignInError)) console.error(`[auth] ${provider} sign-in failed:`, (err as Error).message);
    return reply.redirect(`${config.dashboardUrl}${back}?error=${code}&provider=${provider}`);
  }
}

async function onlySignInMethod(userId: string, dropping: ProviderId): Promise<boolean> {
  const user = await one('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (user?.password_hash) return false;
  const others = await one<{ n: number }>('SELECT count(*)::int AS n FROM user_identities WHERE user_id = $1 AND provider <> $2', [userId, dropping]);
  return (others?.n ?? 0) === 0;
}

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/config', async () => {
    await ensureProviderSettings();
    return {
      githubEnabled: githubOAuthEnabled(),
      githubAppSlug: config.github.appSlug || null,
      appsDomain: config.appsDomain,
      edgeHttpPort: config.edgeHttpPort,
      driver: (await one('SELECT driver FROM nodes ORDER BY last_heartbeat DESC LIMIT 1'))?.driver ?? config.driver,
      auth: { providers: Object.fromEntries(PROVIDERS.map((p) => [p, providerEnabled(p)])) },
      version: '0.1.0',
    };
  });

  // ---- Email + password ----

  app.post('/auth/signup', strict, async (req, reply) => {
    const body = Signup.parse(req.body);
    const exists = await one('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists) throw new HttpError(409, 'email_taken', 'an account with that email already exists');
    // Accounts in a domain whose org enforces SSO are created by signing in through the org's IdP.
    await assertSsoNotRequired(body.email);
    const userId = id('usr');
    const name = body.name ?? nameFromEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    await tx(async (c) => {
      await c.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [userId, body.email, name, passwordHash]);
      await onboardUser(c, userId, name, body.email);
    });
    await createSession(reply, req, userId);
    const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
    return reply.status(201).send({ user: await meOut(user!), workspaces: await userWorkspaces(userId) });
  });

  app.post('/auth/login', strict, async (req, reply) => {
    const body = Login.parse(req.body);
    const user = await one('SELECT * FROM users WHERE email = $1', [body.email]);
    // Always run a hash to keep timing uniform whether or not the user exists.
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'incorrect email or password');
    await assertSsoNotRequired(user.email);
    if ((await beginSession(req, reply, user.id)) === 'mfa') return { mfaRequired: true };
    return { user: await meOut(user), workspaces: await userWorkspaces(user.id) };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (req) => {
    const u = requireUser(req);
    const user = await one('SELECT * FROM users WHERE id = $1', [u.id]);
    return { user: await meOut(user!), workspaces: await userWorkspaces(u.id), orgs: await userOrgs(u.id) };
  });

  // ---- Password reset ----

  app.post('/auth/password/forgot', strict, async (req, reply) => {
    const { email } = z.object({ email: Email }).parse(req.body);
    const user = await one('SELECT id, email FROM users WHERE email = $1', [email]);
    if (user) {
      const token = randomBytes(32).toString('base64url');
      await q('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      await q('INSERT INTO password_resets (id, user_id, expires_at, ip) VALUES ($1,$2,$3,$4)', [sha256(token), user.id, new Date(Date.now() + RESET_TTL_MS), req.ip]);
      // NAV has no mail transport yet: the operator relays this link (it is only ever written to the server log).
      const link = `${config.dashboardUrl}/reset-password?token=${token}`;
      console.log(`[auth] password reset requested for ${user.email}: ${link} (expires in 1 hour)`);
      void sendMail({ to: user.email, subject: 'Reset your NAV password', ...layout('Reset your password', ['Someone asked to reset the password for your NAV account. The link works once and expires in an hour.', 'If this was not you, ignore this email.'], { label: 'Choose a new password', url: link }) }).catch((e) => console.error('[mail]', e.message));
    }
    // Same answer whether or not the account exists.
    return reply.status(202).send({ ok: true });
  });

  app.get('/auth/password/reset/:token', strict, async (req) => {
    const { token } = req.params as { token: string };
    const row = await one('SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.id = $1 AND r.used_at IS NULL AND r.expires_at > now()', [sha256(token)]);
    if (!row) throw new HttpError(410, 'reset_expired', 'this reset link is invalid or has expired');
    const [local, domain] = String(row.email).split('@');
    return { email: `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}` };
  });

  app.post('/auth/password/reset', strict, async (req, reply) => {
    const body = z.object({ token: z.string().min(20).max(200), password: Password }).parse(req.body);
    const target = await one('SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.id = $1', [sha256(body.token)]);
    if (target) await assertSsoNotRequired(target.email);
    const hash = await hashPassword(body.password);
    const userId = await tx(async (c) => {
      const r = await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [sha256(body.token)]);
      if (!r.rowCount) throw new HttpError(410, 'reset_expired', 'this reset link is invalid or has expired');
      const uid = r.rows[0].user_id as string;
      // Receiving the link proves control of the address.
      await c.query('UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [uid, hash]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [uid]);
      return uid;
    });
    if ((await beginSession(req, reply, userId)) === 'mfa') return { mfaRequired: true };
    const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
    return { user: await meOut(user!), workspaces: await userWorkspaces(userId) };
  });

  // ---- External providers ----

  app.get('/auth/github', async (req, reply) => {
    await ensureProviderSettings();
    if (!githubOAuthEnabled()) return reply.redirect(`${config.dashboardUrl}/login?error=provider_disabled&provider=github`);
    const { mode, next } = req.query as { mode?: string; next?: string };
    const state = randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkcePair();
    writeOAuthState(req, reply, { p: 'github', s: state, v: verifier, m: mode === 'connect' && req.user ? 'connect' : 'login', n: safeNext(next) });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', githubClientId());
    url.searchParams.set('redirect_uri', callbackUrl('github'));
    url.searchParams.set('scope', 'read:user user:email repo');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return reply.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const st = readOAuthState(req, reply, 'github', state);
    if (!st || !code) return reply.redirect(`${config.dashboardUrl}/login?error=bad_state`);
    await ensureProviderSettings();
    let token = '';
    let login = '';
    return finishOAuth(req, reply, 'github', st, async () => {
      const gh = await oauthExchange(code, st.v, callbackUrl('github'));
      token = gh.token;
      login = gh.user.login;
      // Only the primary address GitHub marks verified is used (see oauthExchange).
      return { subject: String(gh.user.id), email: gh.user.email, emailVerified: !!gh.user.email, name: gh.user.name ?? gh.user.login, username: gh.user.login, avatarUrl: gh.user.avatar_url };
    }, async (userId) => {
      const subject = (await one('SELECT subject FROM user_identities WHERE user_id = $1 AND provider = $2', [userId, 'github']))?.subject;
      await q('UPDATE users SET github_id = $2, github_login = $3, github_token_enc = $4 WHERE id = $1', [userId, Number(subject), login, encrypt(token)]);
    });
  });

  app.get('/auth/oauth/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { mode, next, login_hint: hint } = req.query as { mode?: string; next?: string; login_hint?: string };
    if (!PROVIDERS.includes(provider as ProviderId) || provider === 'github') throw notFound('provider');
    const p = provider as Exclude<ProviderId, 'github'>;
    await ensureProviderSettings();
    if (!providerEnabled(p)) return reply.redirect(`${config.dashboardUrl}/login?error=provider_disabled&provider=${p}`);
    const state = randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkcePair();
    writeOAuthState(req, reply, { p, s: state, v: verifier, m: mode === 'connect' && req.user ? 'connect' : 'login', n: safeNext(next) });
    try {
      return reply.redirect(await authorizeUrl(p, state, challenge, typeof hint === 'string' ? hint.slice(0, 254) : undefined));
    } catch (err) {
      console.error(`[auth] ${p} start failed:`, (err as Error).message);
      return reply.redirect(`${config.dashboardUrl}/login?error=provider_error&provider=${p}`);
    }
  });

  app.get('/auth/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (!PROVIDERS.includes(provider as ProviderId) || provider === 'github') throw notFound('provider');
    const p = provider as Exclude<ProviderId, 'github'>;
    const st = readOAuthState(req, reply, p, state);
    if (error === 'access_denied') return reply.redirect(`${config.dashboardUrl}/login?error=cancelled&provider=${p}`);
    if (!st || !code) return reply.redirect(`${config.dashboardUrl}/login?error=bad_state`);
    await ensureProviderSettings();
    return finishOAuth(req, reply, p, st, () => exchange(p, code, st.v));
  });

  /**
   * Single sign-on lookup: tells the client where to send a user whose email domain uses an IdP — the SAML IdP of
   * the org that verified the domain, else the server-wide OpenID Connect provider.
   */
  app.post('/auth/sso', strict, async (req) => {
    const { email } = z.object({ email: Email }).parse(req.body);
    const domain = emailDomain(email);
    const org = await orgForEmail(email);
    if (org?.samlEnabled) return { redirect: `/api/v1/auth/saml/${org.orgId}/login?login_hint=${encodeURIComponent(email)}` };
    if (!providerEnabled('sso') || !config.sso.domains.includes(domain)) {
      throw new HttpError(404, 'sso_not_configured', `single sign-on isn't set up for ${domain}`);
    }
    return { redirect: `/api/v1/auth/oauth/sso/start?login_hint=${encodeURIComponent(email)}` };
  });

  // ---- Account ----

  app.patch('/auth/me', async (req) => {
    const u = requireUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), avatarUrl: z.string().max(2000).nullable().optional(), emailNotifications: z.boolean().optional() }).parse(req.body);
    if (body.emailNotifications !== undefined) await q('UPDATE users SET email_notifications = $2 WHERE id = $1', [u.id, body.emailNotifications]);
    if (body.avatarUrl) {
      // Avatars can only come from a connected provider, never an arbitrary URL.
      const ok = await one('SELECT 1 FROM user_identities WHERE user_id = $1 AND avatar_url = $2', [u.id, body.avatarUrl]);
      if (!ok) throw new HttpError(400, 'bad_avatar', 'choose an avatar from a connected account');
    }
    if (body.name !== undefined) await q('UPDATE users SET name = $2 WHERE id = $1', [u.id, body.name]);
    if (body.avatarUrl !== undefined) await q('UPDATE users SET avatar_url = $2 WHERE id = $1', [u.id, body.avatarUrl]);
    const user = await one('SELECT * FROM users WHERE id = $1', [u.id]);
    return { user: userOut(user!) };
  });

  app.post('/auth/me/email', strict, async (req) => {
    const u = requireUser(req);
    const body = z.object({ email: Email, currentPassword: z.string().max(256).optional() }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE id = $1', [u.id]);
    if (user!.password_hash && !(await verifyPassword(body.currentPassword ?? '', user!.password_hash))) {
      throw new HttpError(403, 'wrong_password', 'current password is incorrect');
    }
    if (body.email === user!.email) return { user: userOut(user!) };
    if (await one('SELECT 1 FROM users WHERE email = $1', [body.email])) throw new HttpError(409, 'email_taken', 'that email is already in use');
    // A new address is unverified until a provider or a reset link vouches for it.
    const row = await one('UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1 RETURNING *', [u.id, body.email]);
    return { user: userOut(row!) };
  });

  app.post('/auth/password/change', strict, async (req) => {
    const u = requireUser(req);
    const body = z.object({ currentPassword: z.string().max(256).optional(), newPassword: Password }).parse(req.body);
    const user = await one('SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (user?.password_hash && !(await verifyPassword(body.currentPassword ?? '', user.password_hash))) {
      throw new HttpError(403, 'wrong_password', 'current password is incorrect');
    }
    await q('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.newPassword)]);
    // Sign out every other session.
    await q('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, sha256(req.cookies[SESSION_COOKIE] ?? '')]);
    return { ok: true };
  });

  app.get('/auth/sessions', async (req) => {
    const u = requireUser(req);
    const current = sha256(req.cookies[SESSION_COOKIE] ?? '');
    const rows = await q('SELECT * FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC', [u.id]);
    return { items: rows.map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent, current: r.id === current })) };
  });

  app.delete('/auth/sessions/:id', async (req, reply) => {
    const u = requireUser(req);
    const { id: sid } = req.params as { id: string };
    const res = await q('DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id', [sid, u.id]);
    if (!res.length) throw notFound('session');
    return reply.status(204).send();
  });

  app.delete('/auth/sessions', async (req, reply) => {
    const u = requireUser(req);
    await q('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, sha256(req.cookies[SESSION_COOKIE] ?? '')]);
    return reply.status(204).send();
  });

  app.get('/auth/identities', async (req) => {
    const u = requireUser(req);
    const rows = await q('SELECT * FROM user_identities WHERE user_id = $1 ORDER BY created_at', [u.id]);
    await ensureProviderSettings();
    return {
      items: rows.map((r) => ({ provider: r.provider, email: r.email, username: r.username, avatarUrl: r.avatar_url, createdAt: r.created_at, lastUsedAt: r.last_used_at })),
      available: Object.fromEntries(PROVIDERS.map((p) => [p, providerEnabled(p)])),
    };
  });

  app.delete('/auth/identities/:provider', async (req, reply) => {
    const u = requireUser(req);
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider as ProviderId)) throw notFound('connection');
    if (await onlySignInMethod(u.id, provider as ProviderId)) {
      throw new HttpError(409, 'last_sign_in_method', 'set a password or connect another account before removing your only way to sign in');
    }
    const res = await q('DELETE FROM user_identities WHERE user_id = $1 AND provider = $2 RETURNING avatar_url', [u.id, provider]);
    if (!res.length) throw notFound('connection');
    if (provider === 'github') await q('UPDATE users SET github_id = NULL, github_login = NULL, github_token_enc = NULL WHERE id = $1', [u.id]);
    await q('UPDATE users SET avatar_url = NULL WHERE id = $1 AND avatar_url = $2', [u.id, res[0].avatar_url]);
    return reply.status(204).send();
  });

  app.delete('/auth/me', strict, async (req, reply) => {
    const u = requireUser(req);
    const body = z.object({ confirm: z.string(), password: z.string().max(256).optional() }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE id = $1', [u.id]);
    if (body.confirm.trim().toLowerCase() !== user!.email) throw new HttpError(400, 'confirm_mismatch', 'type your email address to confirm');
    if (user!.password_hash && !(await verifyPassword(body.password ?? '', user!.password_hash))) {
      throw new HttpError(403, 'wrong_password', 'current password is incorrect');
    }
    const owned = await q(
      `SELECT w.id, w.name,
         (SELECT count(*)::int FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS members,
         (SELECT count(*)::int FROM workspace_members m3 WHERE m3.workspace_id = w.id AND m3.role = 'owner') AS owners,
         (SELECT count(*)::int FROM services s WHERE s.workspace_id = w.id) + (SELECT count(*)::int FROM databases d WHERE d.workspace_id = w.id) AS resources
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1 AND m.role = 'owner'`,
      [u.id],
    );
    for (const w of owned) {
      if (w.members > 1 && w.owners === 1) throw new HttpError(409, 'sole_owner', `transfer ownership of "${w.name}" before deleting your account`);
      if (w.members === 1 && w.resources > 0) throw new HttpError(409, 'workspace_not_empty', `delete the services and databases in "${w.name}" first`);
    }
    await tx(async (c) => {
      for (const w of owned) if (w.members === 1) await c.query('DELETE FROM workspaces WHERE id = $1', [w.id]);
      await c.query('DELETE FROM users WHERE id = $1', [u.id]);
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  // ---- API keys ----

  app.get('/api-keys', async (req) => {
    const u = requireUser(req);
    const rows = await q('SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [u.id]);
    return { items: rows.map(ser.apiKey), nextCursor: null };
  });

  app.post('/api-keys', async (req, reply) => {
    const u = requireUser(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const k = newApiKey();
    const row = await one('INSERT INTO api_keys (id, user_id, name, token_hash, prefix) VALUES ($1,$2,$3,$4,$5) RETURNING *', [k.id, u.id, name, k.hash, k.prefix]);
    return reply.status(201).send({ apiKey: ser.apiKey(row!), token: k.token });
  });

  app.delete('/api-keys/:id', async (req, reply) => {
    const u = requireUser(req);
    const { id: keyId } = req.params as { id: string };
    const res = await q('DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id', [keyId, u.id]);
    if (!res.length) throw notFound('API key');
    return reply.status(204).send();
  });

  await adminRoutes(app);
}
