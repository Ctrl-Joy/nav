// Workflows API: tasks discovered from the live deploy, runs (start / list / inspect / cancel / retry) and run logs.
// A workflow is a service of type 'workflow'; `:id` accepts its id or slug. Besides users (session or API key),
// services may call the run endpoints with their injected NAV_WORKFLOWS_TOKEN, scoped to their own workspace.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Role } from '@nav/shared';
import { one, q, type Row } from '../../db/pool.ts';
import { badRequest, notFound, recordEvent } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { cancelRun, createRun, retryRun, runCounts, tasksOf } from '../../lib/workflows.ts';
import { requireUser, workspaceRole } from '../auth.ts';
import { fetchLogs, streamLogs } from './services.ts';

interface Caller { actorId: string | null; viaToken: boolean }

/** Resolves the caller's access to a workspace: a member with `min`, or (when allowed) a service token for it. */
async function access(req: FastifyRequest, workspaceId: string, min: Role, allowToken: boolean, what: string): Promise<Caller> {
  if (req.authKind === 'workflow_token') {
    if (!allowToken || req.tokenWorkspaceId !== workspaceId) throw notFound(what);
    return { actorId: null, viaToken: true };
  }
  await workspaceRole(req, workspaceId, min).catch((err) => { throw err.status === 403 ? err : notFound(what); });
  return { actorId: requireUser(req).id, viaToken: false };
}

async function workflowFor(req: FastifyRequest, min: Role = 'viewer', allowToken = false): Promise<{ svc: Row } & Caller> {
  const ref = (req.params as { id: string }).id;
  const svc = await one("SELECT * FROM services WHERE (id = $1 OR slug = $1) AND type = 'workflow' AND status <> 'deleting'", [ref]);
  if (!svc) throw notFound('workflow');
  return { svc, ...(await access(req, svc.workspace_id, min, allowToken, 'workflow')) };
}

async function runFor(req: FastifyRequest, min: Role = 'viewer', allowToken = false): Promise<{ run: Row; svc: Row } & Caller> {
  const run = await one('SELECT * FROM workflow_runs WHERE id = $1', [(req.params as { id: string }).id]);
  if (!run) throw notFound('workflow run');
  const svc = await one('SELECT * FROM services WHERE id = $1', [run.service_id]);
  if (!svc) throw notFound('workflow run');
  return { run, svc, ...(await access(req, svc.workspace_id, min, allowToken, 'workflow run')) };
}

async function workflowView(svc: Row) {
  return {
    service: ser.service(svc),
    maxConcurrency: svc.workflow_concurrency,
    tasks: (await tasksOf(svc.current_deploy_id)).map(ser.workflowTask),
    counts: await runCounts(svc.id),
  };
}

const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'];

const StartRun = z.object({
  input: z.unknown().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  trigger: z.enum(['dashboard', 'api', 'cli']).optional(),
});

export async function workflowRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/workflows', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const rows = await q("SELECT * FROM services WHERE workspace_id = $1 AND type = 'workflow' AND status <> 'deleting' AND parent_service_id IS NULL ORDER BY name", [ws]);
    return { items: await Promise.all(rows.map(workflowView)), nextCursor: null };
  });

  app.get('/workflows/:id', async (req) => workflowView((await workflowFor(req)).svc));

  app.patch('/workflows/:id', async (req) => {
    const { svc, actorId } = await workflowFor(req, 'developer');
    const body = z.object({ maxConcurrency: z.number().int().min(1).max(100) }).parse(req.body);
    const row = await one('UPDATE services SET workflow_concurrency = $2, updated_at = now() WHERE id = $1 RETURNING *', [svc.id, body.maxConcurrency]);
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId, kind: 'settings_updated', data: { fields: ['maxConcurrency'] } });
    return workflowView(row!);
  });

  app.get('/workflows/:id/tasks', async (req) => {
    const { svc } = await workflowFor(req, 'viewer', true);
    return { items: (await tasksOf(svc.current_deploy_id)).map(ser.workflowTask) };
  });

  // Start a run. Idempotency: the same key (body `idempotencyKey` or `Idempotency-Key` header) returns the first run.
  app.post('/workflows/:id/tasks/:name/runs', async (req, reply) => {
    const { svc, actorId, viaToken } = await workflowFor(req, 'developer', true);
    const body = StartRun.parse(req.body ?? {});
    const header = req.headers['idempotency-key'];
    const idempotencyKey = body.idempotencyKey ?? (typeof header === 'string' && header ? header.slice(0, 255) : null);
    const trigger = viaToken ? 'service' : (body.trigger ?? (req.authKind === 'api_key' ? 'api' : 'dashboard'));
    const { run, created } = await createRun(svc, { task: (req.params as { name: string }).name, input: body.input, idempotencyKey, trigger, actorId });
    if (created) await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId, kind: 'workflow_run_started', data: { runId: run.id, task: run.task, trigger } });
    return reply.status(created ? 201 : 200).send(ser.workflowRun(run));
  });

  app.get('/workflows/:id/runs', async (req) => {
    const { svc } = await workflowFor(req, 'viewer', true);
    const f = req.query as { status?: string; task?: string; q?: string; scope?: string; parentRunId?: string; cursor?: string; limit?: string };
    const where = ['service_id = $1'];
    const params: unknown[] = [svc.id];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.status) {
      const statuses = f.status.split(',').filter((s) => RUN_STATUSES.includes(s));
      if (!statuses.length) throw badRequest(`status must be one of ${RUN_STATUSES.join(', ')}`);
      add('status = ANY(?)', statuses);
    }
    if (f.task) add('task = ANY(?)', f.task.split(','));
    if (f.parentRunId) add('parent_run_id = ?', f.parentRunId);
    else if (f.scope !== 'all') where.push('parent_run_id IS NULL');
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      where.push(`(id ILIKE $${params.length} OR COALESCE(idempotency_key, '') ILIKE $${params.length})`);
    }
    if (f.cursor) add('created_at < ?', f.cursor);
    const limit = Math.min(Number(f.limit) || 50, 200);
    const rows = await q(`SELECT * FROM workflow_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, params);
    return { items: rows.map(ser.workflowRun), nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null };
  });

  app.get('/workflow-runs/:id', async (req) => {
    const { run } = await runFor(req, 'viewer', true);
    const steps = await q('SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY seq', [run.id]);
    const tree = await q('SELECT * FROM workflow_runs WHERE root_run_id = $1 OR id = $1 ORDER BY created_at, id LIMIT 2000', [run.root_run_id ?? run.id]);
    return { run: ser.workflowRun(run), steps: steps.map(ser.workflowStep), tree: tree.map(ser.workflowRun) };
  });

  app.post('/workflow-runs/:id/cancel', async (req) => {
    const { run, svc, actorId } = await runFor(req, 'developer', true);
    const ids = await cancelRun(run);
    if (ids.length) await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId, kind: 'workflow_run_canceled', data: { runId: run.id, task: run.task, canceled: ids.length } });
    return ser.workflowRun((await one('SELECT * FROM workflow_runs WHERE id = $1', [run.id]))!);
  });

  app.post('/workflow-runs/:id/retry', async (req, reply) => {
    const { run, svc, actorId } = await runFor(req, 'developer');
    const next = await retryRun(svc, run, actorId);
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId, kind: 'workflow_run_started', data: { runId: next.id, task: next.task, trigger: 'retry', retryOf: run.id } });
    return reply.status(201).send(ser.workflowRun(next));
  });

  app.get('/workflow-runs/:id/logs', async (req) => {
    const { run } = await runFor(req, 'viewer', true);
    return { items: await fetchLogs({ ...(req.query as object), limit: (req.query as { limit?: string }).limit ?? '2000' }, { col: 'run_id', value: run.id }) };
  });

  app.get('/workflow-runs/:id/logs/stream', async (req, reply) => {
    const { run } = await runFor(req);
    (req.query as Record<string, string>).after ??= '0';
    streamLogs(req, reply, { col: 'run_id', value: run.id }, (n) => n.runId === run.id, async () => {
      const r = await one('SELECT status FROM workflow_runs WHERE id = $1', [run.id]);
      return !r || ['succeeded', 'failed', 'canceled'].includes(r.status);
    });
  });
}
