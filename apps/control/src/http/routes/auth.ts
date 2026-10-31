import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '@nav/shared/config';
import { encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { slugify } from '@nav/shared';
import { one, q, tx, type Client } from '../../db/pool.ts';
import { HttpError, notFound } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { githubOAuthEnabled, oauthExchange } from '../../lib/github.ts';
import { createSession, destroySession, hashPassword, newApiKey, requireUser, verifyPassword } from '../auth.ts';

const Signup = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(256),
  name: z.string().trim().min(1).max(100),
});
const Login = z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(256) });

export async function userWorkspaces(userId: string) {
  const rows = await q(
    `SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 ORDER BY w.created_at`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, role: r.role, createdAt: r.created_at }));
}

function userOut(r: Record<string, any>) {
  return { id: r.id, email: r.email, name: r.name, githubLogin: r.github_login, avatarUrl: r.avatar_url, createdAt: r.created_at };
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

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/config', async () => ({
    githubEnabled: githubOAuthEnabled(),
    githubAppSlug: config.github.appSlug || null,
    appsDomain: config.appsDomain,
    edgeHttpPort: config.edgeHttpPort,
    driver: (await one('SELECT driver FROM nodes ORDER BY last_heartbeat DESC LIMIT 1'))?.driver ?? config.driver,
    version: '0.1.0',
  }));

  app.post('/auth/signup', strict, async (req, reply) => {
    const body = Signup.parse(req.body);
    const exists = await one('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists) throw new HttpError(409, 'email_taken', 'an account with that email already exists');
    const userId = id('usr');
    const passwordHash = await hashPassword(body.password);
    await tx(async (c) => {
      await c.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [userId, body.email, body.name, passwordHash]);
      await onboardUser(c, userId, body.name, body.email);
    });
    await createSession(reply, req, userId);
    const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
    return reply.status(201).send({ user: userOut(user!), workspaces: await userWorkspaces(userId) });
  });

  app.post('/auth/login', strict, async (req, reply) => {
    const body = Login.parse(req.body);
    const user = await one('SELECT * FROM users WHERE email = $1', [body.email]);
    // Always run a hash to keep timing uniform whether or not the user exists.
    const ok = await verifyPassword(body.password, user?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'incorrect email or password');
    await createSession(reply, req, user.id);
    return { user: userOut(user), workspaces: await userWorkspaces(user.id) };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (req) => {
    const u = requireUser(req);
    const user = await one('SELECT * FROM users WHERE id = $1', [u.id]);
    return { user: userOut(user!), workspaces: await userWorkspaces(u.id) };
  });

  // GitHub OAuth (sign in / connect account so repos can be listed).
  app.get('/auth/github', async (req, reply) => {
    if (!githubOAuthEnabled()) throw notFound('GitHub integration');
    const state = randomBytes(16).toString('base64url');
    reply.setCookie('nav_oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600 });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.github.clientId);
    url.searchParams.set('redirect_uri', `${config.apiPublicUrl}/api/v1/auth/github/callback`);
    url.searchParams.set('scope', 'read:user user:email repo');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || state !== req.cookies.nav_oauth_state) throw new HttpError(400, 'bad_state', 'invalid OAuth state');
    reply.clearCookie('nav_oauth_state', { path: '/' });
    const gh = await oauthExchange(code);
    let userId = req.user?.id ?? (await one('SELECT id FROM users WHERE github_id = $1', [gh.user.id]))?.id;
    if (!userId && gh.user.email) userId = (await one('SELECT id FROM users WHERE email = $1', [gh.user.email.toLowerCase()]))?.id;
    if (!userId) {
      if (!gh.user.email) throw new HttpError(400, 'no_email', 'your GitHub account has no verified email');
      userId = id('usr');
      const name = gh.user.name ?? gh.user.login;
      await tx(async (c) => {
        await c.query('INSERT INTO users (id, email, name) VALUES ($1,$2,$3)', [userId, gh.user.email!.toLowerCase(), name]);
        await onboardUser(c, userId!, name, gh.user.email!);
      });
    }
    await q('UPDATE users SET github_id = $2, github_login = $3, avatar_url = $4, github_token_enc = $5 WHERE id = $1', [userId, gh.user.id, gh.user.login, gh.user.avatar_url, encrypt(gh.token)]);
    if (!req.user) await createSession(reply, req, userId!);
    return reply.redirect(`${config.dashboardUrl}/dashboard`);
  });

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
}
