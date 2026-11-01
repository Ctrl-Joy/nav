import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '@nav/shared/ids';
import { one, q } from '../../db/pool.ts';
import { enqueue, notFound, recordEvent } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { deleteResources, fetchBlueprintFile, parseBlueprint, planBlueprint } from '../../lib/blueprints.ts';
import { lsRemote, validateRepoUrl } from '../../lib/git.ts';
import { deletePreviewEnvironment, previewEnvironment } from '../../lib/previews.ts';
import { requireUser, scoped, workspaceRole } from '../auth.ts';

async function out(bpId: string) {
  const bp = await one('SELECT * FROM blueprints WHERE id = $1', [bpId]);
  const res = await q('SELECT * FROM blueprint_resources WHERE blueprint_id = $1 ORDER BY resource_type, name', [bpId]);
  return ser.blueprint(bp!, res);
}

const BlueprintPreviews = z.object({ generation: z.enum(['off', 'manual', 'automatic']), expireAfterDays: z.number().int().min(0).max(365) });

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

  // "Deploy to NAV": read a repository's blueprint file so the dashboard can show what would be created.
  app.post('/blueprints/inspect', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    requireUser(req);
    const body = z.object({
      repoUrl: z.string().max(500),
      branch: z.string().min(1).max(255).optional(),
      filePath: z.string().max(255).regex(/^[^/\\][^\\]*\.ya?ml$/).default('nav.yaml'),
    }).parse(req.body);
    const repoUrl = validateRepoUrl(body.repoUrl);
    const branch = body.branch ?? (await lsRemote(repoUrl)).defaultBranch ?? 'main';
    const name = decodeURIComponent(new URL(repoUrl).pathname.split('/').filter(Boolean).pop() ?? 'blueprint').replace(/\.git$/, '');
    let yaml = '';
    try {
      yaml = (await fetchBlueprintFile({ repo_url: repoUrl, branch, file_path: body.filePath })).text;
      const spec = parseBlueprint(yaml);
      return {
        valid: true, errors: [], repoUrl, branch, filePath: body.filePath, name, yaml,
        services: spec.services.map((s) => ({ name: s.name, type: s.type, runtime: s.runtime ?? (s.image ? 'image' : 'auto'), plan: s.plan ?? null })),
        databases: spec.databases.map((d) => ({ name: d.name, plan: d.plan ?? null })),
        envGroups: spec.envVarGroups.map((g) => ({ name: g.name })),
        previews: spec.previews ?? null,
      };
    } catch (err) {
      return { valid: false, errors: [(err as Error).message], repoUrl, branch, filePath: body.filePath, name, yaml, services: [], databases: [], envGroups: [], previews: null };
    }
  });

  app.get('/blueprints/:id', async (req) => out((await bpFor(req)).row.id));

  app.patch('/blueprints/:id', async (req) => {
    const { row } = await bpFor(req, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), branch: z.string().min(1).max(255).optional(), autoSync: z.boolean().optional(), previews: BlueprintPreviews.optional() }).parse(req.body);
    await q('UPDATE blueprints SET name = COALESCE($2, name), branch = COALESCE($3, branch), auto_sync = COALESCE($4, auto_sync), previews = COALESCE($5, previews) WHERE id = $1', [row.id, body.name ?? null, body.branch ?? null, body.autoSync ?? null, body.previews ? JSON.stringify(body.previews) : null]);
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
      for (const env of await q('SELECT * FROM preview_environments WHERE blueprint_id = $1', [row.id])) await deletePreviewEnvironment(env, requireUser(req).id);
      await deleteResources(res.map((r) => ({ type: r.resource_type, id: r.resource_id })), requireUser(req).id);
    }
    await q('DELETE FROM blueprints WHERE id = $1', [row.id]);
    return reply.status(204).send();
  });

  // ---- Preview environments --------------------------------------------------------------------------
  app.get('/blueprints/:id/previews', async (req) => {
    const { row } = await bpFor(req);
    const envs = await q('SELECT * FROM preview_environments WHERE blueprint_id = $1 ORDER BY pr_number DESC', [row.id]);
    const ids = envs.flatMap((e) => (e.resources as { type: string; id: string }[]).filter((r) => r.type === 'service').map((r) => r.id));
    const svcs = ids.length ? await q('SELECT id, type, slug, status FROM services WHERE id = ANY($1)', [ids]) : [];
    return { items: envs.map((e) => previewEnvironment(e, svcs)), nextCursor: null };
  });

  app.delete('/blueprint-previews/:id', async (req, reply) => {
    const env = await one('SELECT * FROM preview_environments WHERE id = $1', [(req.params as { id: string }).id]);
    if (!env) throw notFound('preview environment');
    await workspaceRole(req, env.workspace_id, 'developer').catch((err) => {
      throw err.status === 403 ? err : notFound('preview environment');
    });
    await deletePreviewEnvironment(env, requireUser(req).id);
    return reply.status(204).send();
  });
}
