import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '@nav/shared/ids';
import type { EnvGroup } from '@nav/shared';
import { one, q, tx, type Row } from '../../db/pool.ts';
import { recordEvent } from '../../lib/core.ts';
import { createDeploy } from '../../lib/deploys.ts';
import { listEnv, listFiles, replaceEnv, replaceFiles } from '../../lib/env.ts';
import { atLeast, requireUser, scoped, workspaceRole } from '../auth.ts';

const EnvVar = z.object({ key: z.string().min(1).max(256), value: z.string().max(65536) });
const SecretFile = z.object({ filename: z.string().min(1).max(128), content: z.string().max(524288) });

async function groupOut(g: Row, reveal: boolean): Promise<EnvGroup> {
  const vars = await listEnv('group', g.id);
  const files = await listFiles('group', g.id);
  const links = await q('SELECT service_id FROM service_env_groups WHERE group_id = $1', [g.id]);
  return {
    id: g.id,
    workspaceId: g.workspace_id,
    name: g.name,
    envVars: reveal ? vars : vars.map((v) => ({ ...v, value: '***' })),
    secretFiles: reveal ? files : files.map((f) => ({ ...f, content: '***' })),
    serviceIds: links.map((l) => l.service_id),
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

/** Redeploy every live service linked to a group after its contents change. */
export async function redeployLinked(groupId: string, actorId: string | null): Promise<void> {
  const svcs = await q(
    "SELECT s.* FROM services s JOIN service_env_groups sg ON sg.service_id = s.id WHERE sg.group_id = $1 AND s.current_deploy_id IS NOT NULL AND NOT s.suspended AND s.status <> 'deleting'",
    [groupId],
  );
  for (const s of svcs) await createDeploy(s, { trigger: 'env_change', actorId }).catch(() => {});
}

export async function envGroupRoutes(app: FastifyInstance) {
  const groupFor = (req: FastifyRequest, min: 'viewer' | 'developer' | 'admin' = 'viewer') => scoped(req, 'env_groups', (req.params as { id: string }).id, min);

  app.get('/workspaces/:ws/env-groups', async (req) => {
    const { ws } = req.params as { ws: string };
    const role = await workspaceRole(req, ws);
    const rows = await q('SELECT * FROM env_groups WHERE workspace_id = $1 ORDER BY name', [ws]);
    return { items: await Promise.all(rows.map((r) => groupOut(r, atLeast(role, 'developer')))), nextCursor: null };
  });

  app.post('/workspaces/:ws/env-groups', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(100), envVars: z.array(EnvVar).max(500).optional(), secretFiles: z.array(SecretFile).max(50).optional() }).parse(req.body);
    const gid = id('evg');
    await tx(async (c) => {
      await c.query('INSERT INTO env_groups (id, workspace_id, name) VALUES ($1,$2,$3)', [gid, ws, body.name]);
      await replaceEnv(c, 'group', gid, body.envVars ?? []);
      await replaceFiles(c, 'group', gid, body.secretFiles ?? []);
    });
    await recordEvent({ workspaceId: ws, actorId: requireUser(req).id, kind: 'env_group_created', data: { name: body.name } });
    return reply.status(201).send(await groupOut((await one('SELECT * FROM env_groups WHERE id = $1', [gid]))!, true));
  });

  app.get('/env-groups/:id', async (req) => {
    const { row, role } = await groupFor(req);
    return groupOut(row, atLeast(role, 'developer'));
  });

  app.patch('/env-groups/:id', async (req) => {
    const { row } = await groupFor(req, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), envVars: z.array(EnvVar).max(500).optional(), secretFiles: z.array(SecretFile).max(50).optional() }).parse(req.body);
    await tx(async (c) => {
      if (body.name) await c.query('UPDATE env_groups SET name = $2 WHERE id = $1', [row.id, body.name]);
      if (body.envVars) await replaceEnv(c, 'group', row.id, body.envVars);
      if (body.secretFiles) await replaceFiles(c, 'group', row.id, body.secretFiles);
      await c.query('UPDATE env_groups SET updated_at = now() WHERE id = $1', [row.id]);
    });
    const actor = requireUser(req).id;
    await recordEvent({ workspaceId: row.workspace_id, actorId: actor, kind: 'env_group_updated', data: { name: body.name ?? row.name } });
    if (body.envVars || body.secretFiles) await redeployLinked(row.id, actor);
    return groupOut((await one('SELECT * FROM env_groups WHERE id = $1', [row.id]))!, true);
  });

  app.delete('/env-groups/:id', async (req, reply) => {
    const { row } = await groupFor(req, 'admin');
    await tx(async (c) => {
      await c.query("DELETE FROM env_vars WHERE owner_type = 'group' AND owner_id = $1", [row.id]);
      await c.query("DELETE FROM secret_files WHERE owner_type = 'group' AND owner_id = $1", [row.id]);
      await c.query('DELETE FROM env_groups WHERE id = $1', [row.id]);
    });
    await recordEvent({ workspaceId: row.workspace_id, actorId: requireUser(req).id, kind: 'env_group_deleted', data: { name: row.name } });
    return reply.status(204).send();
  });
}
