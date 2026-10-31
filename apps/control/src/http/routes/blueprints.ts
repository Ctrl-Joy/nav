import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '@nav/shared/ids';
import { one, q } from '../../db/pool.ts';
import { enqueue, recordEvent } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { parseBlueprint, planBlueprint } from '../../lib/blueprints.ts';
import { validateRepoUrl } from '../../lib/git.ts';
import { markForDeletion } from '../../lib/services.ts';
import { requireUser, scoped, workspaceRole } from '../auth.ts';

async function out(bpId: string) {
  const bp = await one('SELECT * FROM blueprints WHERE id = $1', [bpId]);
  const res = await q('SELECT * FROM blueprint_resources WHERE blueprint_id = $1 ORDER BY resource_type, name', [bpId]);
  return ser.blueprint(bp!, res);
}

export async function blueprintRoutes(app: FastifyInstance) {
  const bpFor = (req: FastifyRequest, min: 'viewer' | 'developer' | 'admin' = 'viewer') => scoped(req, 'blueprints', (req.params as { id: string }).id, min);

  app.get('/workspaces/:ws/blueprints', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const rows = await q('SELECT id FROM blueprints WHERE workspace_id = $1 ORDER BY created_at DESC', [ws]);
    return { items: await Promise.all(rows.map((r) => out(r.id))), nextCursor: null };
  });

  app.post('/workspaces/:ws/blueprints', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      repoUrl: z.string().max(500),
      branch: z.string().min(1).max(255).default('main'),
      filePath: z.string().max(255).regex(/^[^/\\][^\\]*\.ya?ml$/).default('nav.yaml'),
      autoSync: z.boolean().default(true),
    }).parse(req.body);
    const bpId = id('bpr');
    await q('INSERT INTO blueprints (id, workspace_id, name, repo_url, branch, file_path, auto_sync) VALUES ($1,$2,$3,$4,$5,$6,$7)', [bpId, ws, body.name, validateRepoUrl(body.repoUrl), body.branch, body.filePath, body.autoSync]);
    await enqueue('blueprint_sync', { blueprintId: bpId }, { concurrencyKey: `bp:${bpId}` });
    await recordEvent({ workspaceId: ws, actorId: requireUser(req).id, kind: 'blueprint_created', data: { blueprintId: bpId, name: body.name } });
    return reply.status(201).send(await out(bpId));
  });

  app.post('/blueprints/validate', async (req) => {
    requireUser(req);
    const { yaml, blueprintId } = z.object({ yaml: z.string().max(200_000), blueprintId: z.string().optional() }).parse(req.body);
    try {
      const spec = parseBlueprint(yaml);
      return { valid: true, errors: [], plan: await planBlueprint(spec, blueprintId ?? null) };
    } catch (err) {
      return { valid: false, errors: [(err as Error).message], plan: { create: [], update: [], unchanged: [] } };
    }
  });

  app.get('/blueprints/:id', async (req) => out((await bpFor(req)).row.id));

  app.patch('/blueprints/:id', async (req) => {
    const { row } = await bpFor(req, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), branch: z.string().min(1).max(255).optional(), autoSync: z.boolean().optional() }).parse(req.body);
    await q('UPDATE blueprints SET name = COALESCE($2, name), branch = COALESCE($3, branch), auto_sync = COALESCE($4, auto_sync) WHERE id = $1', [row.id, body.name ?? null, body.branch ?? null, body.autoSync ?? null]);
    return out(row.id);
  });

  app.post('/blueprints/:id/sync', async (req) => {
    const { row } = await bpFor(req, 'developer');
    await q("UPDATE blueprints SET status = 'syncing' WHERE id = $1", [row.id]);
    await enqueue('blueprint_sync', { blueprintId: row.id }, { concurrencyKey: `bp:${row.id}` });
    return out(row.id);
  });

  app.delete('/blueprints/:id', async (req, reply) => {
    const { row } = await bpFor(req, 'admin');
    if ((req.query as { deleteResources?: string }).deleteResources === '1') {
      const res = await q('SELECT * FROM blueprint_resources WHERE blueprint_id = $1', [row.id]);
      for (const r of res) {
        if (r.resource_type === 'service') {
          const svc = await one('SELECT * FROM services WHERE id = $1', [r.resource_id]);
          if (svc) await markForDeletion(svc, requireUser(req).id);
        } else if (r.resource_type === 'database') {
          await q("UPDATE databases SET status = 'deleting' WHERE id = $1", [r.resource_id]);
          await enqueue('db_delete', { databaseId: r.resource_id }, { concurrencyKey: `db:${r.resource_id}` });
        } else {
          await q('DELETE FROM env_groups WHERE id = $1', [r.resource_id]);
        }
      }
    }
    await q('DELETE FROM blueprints WHERE id = $1', [row.id]);
    return reply.status(204).send();
  });
}
