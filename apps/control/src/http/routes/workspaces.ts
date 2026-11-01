import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decrypt, sha256 } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { one, q, tx } from '../../db/pool.ts';
import { HttpError, badRequest, conflict, notFound, recordEvent } from '../../lib/core.ts';
import { layout, sendMail } from '../../lib/mail.ts';
import { config } from '@nav/shared/config';
import * as ser from '../../lib/serialize.ts';
import { lsRemote, validateRepoUrl } from '../../lib/git.ts';
import { githubAppEnabled, installationRepos, userRepos } from '../../lib/github.ts';
import { requireUser, scoped, workspaceRole } from '../auth.ts';
import { onChange, openSse } from '../sse.ts';
import { uniqueSlug, userWorkspaces } from './auth.ts';

const Role = z.enum(['owner', 'admin', 'developer', 'viewer']);
const Name = z.string().trim().min(1).max(100);

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/workspaces', async (req) => ({ items: await userWorkspaces(requireUser(req).id), nextCursor: null }));

  app.post('/workspaces', async (req, reply) => {
    const u = requireUser(req);
    const { name } = z.object({ name: Name }).parse(req.body);
    const wsId = id('ws');
    await tx(async (c) => {
      await c.query('INSERT INTO workspaces (id, name, slug) VALUES ($1,$2,$3)', [wsId, name, await uniqueSlug(c, 'workspaces', name)]);
      await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [wsId, u.id]);
    });
    const ws = (await userWorkspaces(u.id)).find((w) => w.id === wsId);
    return reply.status(201).send(ws);
  });

  app.patch('/workspaces/:ws', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const body = z.object({ name: Name.optional(), requireTwoFactor: z.boolean().optional() }).parse(req.body);
    if (body.requireTwoFactor) {
      // Requiring 2FA must not lock out the admin turning it on.
      const me = await one('SELECT totp_enabled_at FROM users WHERE id = $1', [requireUser(req).id]);
      if (!me?.totp_enabled_at) throw new HttpError(400, 'mfa_required', 'turn on two-factor authentication for your own account first');
    }
    await q('UPDATE workspaces SET name = COALESCE($2, name), require_2fa = COALESCE($3, require_2fa) WHERE id = $1', [ws, body.name ?? null, body.requireTwoFactor ?? null]);
    return (await userWorkspaces(requireUser(req).id)).find((w) => w.id === ws);
  });

  // Members -------------------------------------------------------------------
  app.get('/workspaces/:ws/members', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const rows = await q('SELECT u.id, u.email, u.name, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at', [ws]);
    const invites = await q('SELECT id, email, role, created_at FROM workspace_invites WHERE workspace_id = $1 AND accepted_at IS NULL', [ws]);
    return {
      items: rows.map((r) => ({ userId: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.created_at })),
      nextCursor: null,
    };
  });

  app.post('/workspaces/:ws/members', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    const myRole = await workspaceRole(req, ws, 'admin');
    const body = z.object({ email: z.string().trim().toLowerCase().email(), role: Role }).parse(req.body);
    if (body.role === 'owner' && myRole !== 'owner') throw badRequest('only owners can add owners');
    const user = await one('SELECT id, email, name FROM users WHERE email = $1', [body.email]);
    if (user) {
      await q('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role', [ws, user.id, body.role]);
      await recordEvent({ workspaceId: ws, actorId: requireUser(req).id, kind: 'member_added', data: { email: body.email, role: body.role } });
      return reply.status(201).send({ member: { userId: user.id, email: user.email, name: user.name, role: body.role } });
    }
    const token = randomBytes(24).toString('base64url');
    const inviteId = id('inv');
    await q('INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash) VALUES ($1,$2,$3,$4,$5)', [inviteId, ws, body.email, body.role, sha256(token)]);
    const wsRow = await one('SELECT name FROM workspaces WHERE id = $1', [ws]);
    void sendMail({ to: body.email, subject: `You're invited to ${wsRow?.name ?? 'a workspace'} on NAV`, ...layout(`Join ${wsRow?.name ?? 'the workspace'} on NAV`, [`${requireUser(req).name} invited you as ${body.role}.`, 'Sign up or log in with this email address and you will be added automatically.'], { label: 'Accept the invite', url: `${config.dashboardUrl}/signup?email=${encodeURIComponent(body.email)}` }) }).catch((e) => console.error('[mail]', e.message));
    return reply.status(201).send({ invite: { id: inviteId, email: body.email, role: body.role, token } });
  });

  app.patch('/workspaces/:ws/members/:userId', async (req) => {
    const { ws, userId } = req.params as { ws: string; userId: string };
    const myRole = await workspaceRole(req, ws, 'admin');
    const { role } = z.object({ role: Role }).parse(req.body);
    if (role === 'owner' && myRole !== 'owner') throw badRequest('only owners can grant owner');
    await assertNotLastOwner(ws, userId, role);
    const res = await q('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id', [ws, userId, role]);
    if (!res.length) throw notFound('member');
    return { ok: true };
  });

  app.delete('/workspaces/:ws/members/:userId', async (req, reply) => {
    const { ws, userId } = req.params as { ws: string; userId: string };
    if (userId !== requireUser(req).id) await workspaceRole(req, ws, 'admin');
    else await workspaceRole(req, ws);
    await assertNotLastOwner(ws, userId, null);
    await q('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, userId]);
    return reply.status(204).send();
  });

  app.delete('/workspaces/:ws/invites/:inviteId', async (req, reply) => {
    const { ws, inviteId } = req.params as { ws: string; inviteId: string };
    await workspaceRole(req, ws, 'admin');
    await q('DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2', [inviteId, ws]);
    return reply.status(204).send();
  });

  // Projects & environments ----------------------------------------------------
  app.get('/workspaces/:ws/projects', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const projects = await q('SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at', [ws]);
    const envs = await q('SELECT e.* FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = $1 ORDER BY e.created_at', [ws]);
    return {
      items: projects.map((p) => ({
        id: p.id, workspaceId: p.workspace_id, name: p.name, createdAt: p.created_at,
        environments: envs.filter((e) => e.project_id === p.id).map((e) => ({ id: e.id, projectId: e.project_id, name: e.name, protected: e.protected })),
      })),
      nextCursor: null,
    };
  });

  app.post('/workspaces/:ws/projects', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const body = z.object({ name: Name, environments: z.array(z.string().trim().min(1).max(50)).max(10).optional() }).parse(req.body);
    const pid = id('prj');
    const envNames = body.environments?.length ? [...new Set(body.environments)] : ['production'];
    await tx(async (c) => {
      await c.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1,$2,$3)', [pid, ws, body.name]);
      for (const n of envNames) await c.query('INSERT INTO environments (id, project_id, name) VALUES ($1,$2,$3)', [id('env'), pid, n]);
    });
    await recordEvent({ workspaceId: ws, actorId: requireUser(req).id, kind: 'project_created', data: { projectId: pid, name: body.name } });
    const envs = await q('SELECT * FROM environments WHERE project_id = $1 ORDER BY created_at', [pid]);
    return reply.status(201).send({ id: pid, workspaceId: ws, name: body.name, createdAt: new Date().toISOString(), environments: envs.map((e) => ({ id: e.id, projectId: pid, name: e.name, protected: e.protected })) });
  });

  app.patch('/projects/:id', async (req) => {
    const { row } = await scoped(req, 'projects', (req.params as { id: string }).id, 'developer');
    const { name } = z.object({ name: Name }).parse(req.body);
    await q('UPDATE projects SET name = $2 WHERE id = $1', [row.id, name]);
    return { ok: true };
  });

  app.delete('/projects/:id', async (req, reply) => {
    const { row } = await scoped(req, 'projects', (req.params as { id: string }).id, 'admin');
    await q('DELETE FROM projects WHERE id = $1', [row.id]);
    return reply.status(204).send();
  });

  app.post('/projects/:id/environments', async (req, reply) => {
    const { row } = await scoped(req, 'projects', (req.params as { id: string }).id, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(50), protected: z.boolean().optional() }).parse(req.body);
    const eid = id('env');
    await q('INSERT INTO environments (id, project_id, name, protected) VALUES ($1,$2,$3,$4)', [eid, row.id, body.name, body.protected ?? false]);
    return reply.status(201).send({ id: eid, projectId: row.id, name: body.name, protected: body.protected ?? false });
  });

  app.delete('/environments/:id', async (req, reply) => {
    const env = await one('SELECT e.*, p.workspace_id FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.id = $1', [(req.params as { id: string }).id]);
    if (!env) throw notFound('environment');
    await workspaceRole(req, env.workspace_id, 'admin');
    await q('DELETE FROM environments WHERE id = $1', [env.id]);
    return reply.status(204).send();
  });

  // Activity -----------------------------------------------------------------
  app.get('/workspaces/:ws/events', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const n = Math.min(Number(limit) || 50, 200);
    const rows = await q(
      `SELECT e.*, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.workspace_id = $1 AND ($2::bigint IS NULL OR e.id < $2) ORDER BY e.id DESC LIMIT $3`,
      [ws, cursor ? Number(cursor) : null, n],
    );
    return { items: rows.map(ser.event), nextCursor: rows.length === n ? String(rows[rows.length - 1].id) : null };
  });

  app.get('/workspaces/:ws/notifications', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const row = await one('SELECT * FROM notification_settings WHERE workspace_id = $1', [ws]);
    return { webhookUrl: row?.webhook_url ?? null, notifyOn: row?.notify_on ?? 'failure', emailNotifyOn: row?.email_notify_on ?? 'failure' };
  });

  app.put('/workspaces/:ws/notifications', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const body = z.object({ webhookUrl: z.string().url().startsWith('https://').nullable(), notifyOn: z.enum(['all', 'failure', 'none']), emailNotifyOn: z.enum(['all', 'failure', 'none']).default('failure') }).parse(req.body);
    await q(
      `INSERT INTO notification_settings (workspace_id, webhook_url, notify_on, email_notify_on) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, notify_on = EXCLUDED.notify_on, email_notify_on = EXCLUDED.email_notify_on`,
      [ws, body.webhookUrl, body.notifyOn, body.emailNotifyOn],
    );
    return body;
  });

  // Git ----------------------------------------------------------------------
  app.get('/workspaces/:ws/repos', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const out = new Map<string, { fullName: string; cloneUrl: string; defaultBranch: string; private: boolean; installationId: number | null }>();
    if (githubAppEnabled()) {
      for (const inst of await q('SELECT id FROM github_installations WHERE workspace_id = $1', [ws])) {
        for (const r of await installationRepos(Number(inst.id)).catch(() => [])) {
          out.set(r.full_name, { fullName: r.full_name, cloneUrl: r.clone_url.replace(/\.git$/, ''), defaultBranch: r.default_branch, private: r.private, installationId: Number(inst.id) });
        }
      }
    }
    const user = await one('SELECT github_token_enc FROM users WHERE id = $1', [requireUser(req).id]);
    if (user?.github_token_enc) {
      for (const r of await userRepos(decrypt(user.github_token_enc)).catch(() => [])) {
        if (!out.has(r.full_name)) out.set(r.full_name, { fullName: r.full_name, cloneUrl: r.clone_url.replace(/\.git$/, ''), defaultBranch: r.default_branch, private: r.private, installationId: null });
      }
    }
    return { items: [...out.values()], nextCursor: null };
  });

  app.get('/git/branches', async (req) => {
    requireUser(req);
    const { repoUrl } = z.object({ repoUrl: z.string() }).parse(req.query);
    const { branches, defaultBranch } = await lsRemote(validateRepoUrl(repoUrl));
    return { items: branches, defaultBranch };
  });

  // Live change stream for dashboards -------------------------------------------
  app.get('/workspaces/:ws/stream', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const stream = openSse(req, reply);
    stream.send('ready', { workspaceId: ws });
    stream.onClose(onChange((n) => {
      if (n.workspaceId === ws) stream.send('change', { entity: n.entity, id: n.id, serviceId: n.serviceId });
    }));
  });

  // Platform ------------------------------------------------------------------
  app.get('/admin/nodes', async (req) => {
    const u = requireUser(req);
    const owner = await one("SELECT 1 FROM workspace_members WHERE user_id = $1 AND role = 'owner'", [u.id]);
    if (!owner) throw notFound();
    const rows = await q("SELECT *, (last_heartbeat > now() - interval '30 seconds') AS online FROM nodes ORDER BY created_at");
    return { items: rows.map((r) => ({ id: r.id, hostname: r.hostname, driver: r.driver, capacity: r.capacity, online: r.online, lastHeartbeat: r.last_heartbeat })) };
  });
}

async function assertNotLastOwner(ws: string, userId: string, newRole: string | null) {
  if (newRole === 'owner') return;
  const target = await one('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, userId]);
  if (target?.role !== 'owner') return;
  const owners = await one<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [ws]);
  if ((owners?.n ?? 0) <= 1) throw conflict('a workspace must keep at least one owner');
}
