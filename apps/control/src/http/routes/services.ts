import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '@nav/shared/ids';
import { SERVICE_PLANS, type MetricsResponse } from '@nav/shared';
import { notify, one, q, tx, type Row } from '../../db/pool.ts';
import { badRequest, changed, conflict, enqueue, notFound, recordEvent } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { cancelDeploy, createDeploy, serviceOp } from '../../lib/deploys.ts';
import { listEnv, listFiles, patchEnv, replaceEnv, replaceFiles } from '../../lib/env.ts';
import { createPreview, createService, markForDeletion, repoPathError, validateCron, validateDisk, validatePlan } from '../../lib/services.ts';
import { validateRepoUrl } from '../../lib/git.ts';
import { wakeService } from '../../lib/sleep.ts';
import { atLeast, requireUser, scoped, workspaceRole } from '../auth.ts';
import { onChange, onLog, openSse } from '../sse.ts';

const Runtime = z.enum(['auto', 'node', 'python', 'go', 'ruby', 'bun', 'docker', 'image', 'static']);
const EnvVar = z.object({ key: z.string().min(1).max(256), value: z.string().max(65536) });
const SecretFile = z.object({ filename: z.string().min(1).max(128), content: z.string().max(524288) });
const Disk = z.object({ name: z.string().min(1).max(64), mountPath: z.string().min(1).max(256), sizeGB: z.number().int().min(1).max(1024) });
const Cmd = z.string().max(4096).nullable().optional();
// Dockerfile path / Docker context: relative to the repository, never absolute or climbing out with "..".
const RepoPath = z.string().max(255).superRefine((p, ctx) => { const err = repoPathError(p); if (err) ctx.addIssue({ code: 'custom', message: err }); });
const Previews = z.object({ mode: z.enum(['off', 'manual', 'automatic']), expireAfterDays: z.number().int().min(1).max(90) });

const CreateService = z.object({
  name: z.string().trim().min(1).max(64),
  type: z.enum(['web', 'private', 'worker', 'cron', 'static', 'workflow']),
  environmentId: z.string().nullable().optional(),
  runtime: Runtime.optional(),
  repoUrl: z.string().max(500).nullable().optional(),
  branch: z.string().max(255).regex(/^[^\s~^:?*[\\]+$/).nullable().optional(),
  rootDir: z.string().max(255).optional(),
  imageUrl: z.string().max(500).nullable().optional(),
  buildCommand: Cmd,
  startCommand: Cmd,
  preDeployCommand: Cmd,
  dockerfilePath: RepoPath.optional(),
  dockerContext: RepoPath.optional(),
  publishPath: z.string().max(255).nullable().optional(),
  healthCheckPath: z.string().max(255).nullable().optional(),
  port: z.number().int().nullable().optional(),
  plan: z.string().optional(),
  instanceCount: z.number().int().min(1).max(100).optional(),
  autoDeploy: z.enum(['commit', 'checks', 'off']).optional(),
  cronSchedule: z.string().max(100).nullable().optional(),
  envVars: z.array(EnvVar).max(500).optional(),
  secretFiles: z.array(SecretFile).max(50).optional(),
  envGroupIds: z.array(z.string()).max(20).optional(),
  disk: Disk.nullable().optional(),
  previews: Previews.optional(),
});

const UpdateService = CreateService.omit({ type: true, envVars: true, secretFiles: true, envGroupIds: true }).partial().extend({
  autoscaling: z.object({
    enabled: z.boolean(),
    min: z.number().int().min(1).max(100),
    max: z.number().int().min(1).max(100),
    targetCpuPercent: z.number().int().min(10).max(95).nullable(),
    targetMemoryPercent: z.number().int().min(10).max(95).nullable(),
  }).optional(),
  buildFilter: z.object({ paths: z.array(z.string().max(255)).max(50), ignoredPaths: z.array(z.string().max(255)).max(50) }).optional(),
  staticHeaders: z.array(z.object({ path: z.string().min(1).max(255), name: z.string().regex(/^[A-Za-z0-9-]+$/), value: z.string().max(2048) })).max(100).optional(),
  staticRoutes: z.array(z.object({ type: z.enum(['redirect', 'rewrite']), source: z.string().min(1).max(500), destination: z.string().min(1).max(1000) })).max(200).optional(),
  maintenanceMode: z.boolean().optional(),
  ipAllowList: z.array(z.object({ cidr: z.string().regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/, 'expected a CIDR like 203.0.113.0/24'), description: z.string().max(100).default('') })).max(100).optional(),
  edgeCache: z.object({ enabled: z.boolean(), maxTtlSeconds: z.number().int().min(1).max(31_536_000).default(86_400) }).optional(),
  shutdownDelaySeconds: z.number().int().min(1).max(300).optional(),
  registryCredentialId: z.string().max(64).nullable().optional(),
});

const COLUMN: Record<string, string> = {
  name: 'name', environmentId: 'environment_id', runtime: 'runtime', repoUrl: 'repo_url', branch: 'branch', rootDir: 'root_dir', imageUrl: 'image_url',
  buildCommand: 'build_command', startCommand: 'start_command', preDeployCommand: 'pre_deploy_command', dockerfilePath: 'dockerfile_path',
  dockerContext: 'docker_context', publishPath: 'publish_path', healthCheckPath: 'health_check_path', port: 'port', plan: 'plan',
  instanceCount: 'instance_count', autoDeploy: 'auto_deploy', cronSchedule: 'cron_schedule', disk: 'disk', previews: 'previews',
  autoscaling: 'autoscaling', buildFilter: 'build_filter', staticHeaders: 'static_headers', staticRoutes: 'static_routes', maintenanceMode: 'maintenance_mode',
  ipAllowList: 'ip_allow_list', edgeCache: 'edge_cache', shutdownDelaySeconds: 'shutdown_delay_s', registryCredentialId: 'registry_credential_id',
};
const JSON_COLS = new Set(['disk', 'previews', 'autoscaling', 'build_filter', 'static_headers', 'static_routes', 'ip_allow_list', 'edge_cache']);

async function svcFor(req: FastifyRequest, min: 'viewer' | 'developer' | 'admin' = 'viewer') {
  const { row, role } = await scoped(req, 'services', (req.params as { id: string }).id, min);
  if (row.status === 'deleting') throw notFound('service');
  return { svc: row, role };
}

async function deployFor(req: FastifyRequest, min: 'viewer' | 'developer' = 'viewer') {
  const dep = await one('SELECT d.*, s.workspace_id FROM deploys d JOIN services s ON s.id = d.service_id WHERE d.id = $1', [(req.params as { id: string }).id]);
  if (!dep) throw notFound('deploy');
  await workspaceRole(req, dep.workspace_id, min).catch(() => { throw notFound('deploy'); });
  return dep;
}

const LOG_STREAMS = ['build', 'deploy', 'runtime', 'cron', 'job', 'system', 'workflow'];

function logFilters(query: Record<string, string | undefined>, base: { col: string; value: string }) {
  const where = [`${base.col} = $1`];
  const params: unknown[] = [base.value];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (query.stream) add('stream = ANY(?)', query.stream.split(',').filter((s) => LOG_STREAMS.includes(s)));
  if (query.level) add('level = ANY(?)', query.level.split(','));
  if (query.deployId) add('deploy_id = ?', query.deployId);
  if (query.instanceId) add('instance_id = ?', query.instanceId);
  if (query.runId) add('run_id = ?', query.runId);
  if (query.q) add("message ILIKE ? ESCAPE '\\'", `%${query.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
  if (query.since) add('ts >= ?', new Date(query.since));
  if (query.until) add('ts <= ?', new Date(query.until));
  return { where, params };
}

export async function fetchLogs(query: Record<string, string | undefined>, base: { col: string; value: string }) {
  const { where, params } = logFilters(query, base);
  const limit = Math.min(Number(query.limit) || 200, 2000);
  if (query.after) {
    params.push(Number(query.after));
    where.push(`id > $${params.length}`);
    const rows = await q(`SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ${limit}`, params);
    return rows.map(ser.logLine);
  }
  if (query.before) {
    params.push(Number(query.before));
    where.push(`id < $${params.length}`);
  }
  const rows = await q(`SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, params);
  return rows.reverse().map(ser.logLine);
}

/** Streams logs matching `base` + filters over SSE. Coalesces notifications into batched queries. */
export function streamLogs(req: FastifyRequest, reply: Parameters<typeof openSse>[1], base: { col: string; value: string }, match: (n: { serviceId: string | null; databaseId: string | null; deployId: string | null; runId: string | null }) => boolean, isDone?: () => Promise<boolean>) {
  const query = req.query as Record<string, string | undefined>;
  const stream = openSse(req, reply);
  const resume = query.after ?? (req.headers['last-event-id'] as string | undefined);
  let lastId = resume === undefined ? -1 : Number(resume);
  let busy = false;
  let again = false;
  const pump = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      if (lastId < 0) {
        // No resume point: tail from "now".
        const row = await one(`SELECT COALESCE(max(id), 0) AS id FROM logs WHERE ${base.col} = $1`, [base.value]);
        lastId = Number(row?.id ?? 0);
      }
      do {
        again = false;
        const rows = await fetchLogs({ ...query, after: String(lastId), limit: '1000' }, base);
        for (const r of rows) { stream.send('log', r, r.id); lastId = r.id; }
        if (rows.length === 1000) again = true;
      } while (again && !stream.closed);
      if (isDone && (await isDone())) { stream.send('end', {}); stream.end(); }
    } finally {
      busy = false;
    }
  };
  stream.onClose(onLog((n) => { if (match(n)) void pump(); }));
  const poll = setInterval(() => void pump(), 5000);
  stream.onClose(() => clearInterval(poll));
  void pump();
}

const RANGES: Record<string, { ms: number; bucket: string }> = {
  '1h': { ms: 3600e3, bucket: '1 minute' },
  '6h': { ms: 6 * 3600e3, bucket: '5 minutes' },
  '24h': { ms: 24 * 3600e3, bucket: '15 minutes' },
  '7d': { ms: 7 * 86400e3, bucket: '2 hours' },
};

export async function serviceMetrics(svc: Row, range: string): Promise<MetricsResponse> {
  const r = RANGES[range] ?? RANGES['1h'];
  const since = new Date(Date.now() - r.ms);
  const plan = SERVICE_PLANS.find((p) => p.id === svc.plan) ?? SERVICE_PLANS[1];
  const res = await q(
    `SELECT b, sum(cpu) AS cpu, sum(mem) AS mem, count(*)::int AS instances FROM (
       SELECT date_bin($3::interval, ts, TIMESTAMPTZ '2000-01-01') AS b, instance_id, avg(cpu) AS cpu, avg(mem_bytes) AS mem
       FROM metrics WHERE service_id = $1 AND ts >= $2 GROUP BY 1, 2) x GROUP BY b ORDER BY b`,
    [svc.id, since, r.bucket],
  );
  const http = await q(
    `SELECT date_bin($3::interval, minute, TIMESTAMPTZ '2000-01-01') AS b, sum(requests)::int AS req, sum(s5xx)::int AS e5,
            sum(latency_ms_sum) AS lat, sum(bytes_out)::bigint AS bytes
     FROM http_metrics WHERE service_id = $1 AND minute >= $2 GROUP BY 1 ORDER BY 1`,
    [svc.id, since, r.bucket],
  );
  const minutes = Math.max(1, Number.parseInt(r.bucket) * (r.bucket.includes('hour') ? 60 : 1));
  const running = svc.instance_count || 1;
  return {
    cpu: res.map((x) => [x.b, Number(Number(x.cpu).toFixed(4))]),
    cpuLimit: plan.cpu * running,
    memoryMB: res.map((x) => [x.b, Math.round(Number(x.mem) / 1048576)]),
    memoryLimitMB: plan.memoryMB * running,
    instances: res.map((x) => [x.b, x.instances]),
    requests: http.map((x) => [x.b, Math.round(x.req / minutes)]),
    errors5xx: http.map((x) => [x.b, x.e5]),
    latencyAvgMs: http.map((x) => [x.b, x.req ? Math.round(Number(x.lat) / x.req) : 0]),
    bandwidthBytes: http.map((x) => [x.b, Number(x.bytes)]),
  };
}

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function serviceRoutes(app: FastifyInstance) {
  // List / create ---------------------------------------------------------------
  app.get('/workspaces/:ws/services', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const f = req.query as { type?: string; environmentId?: string; q?: string; includePreviews?: string };
    const where = ["workspace_id = $1", "status <> 'deleting'"];
    const params: unknown[] = [ws];
    if (f.type) { params.push(f.type.split(',')); where.push(`type = ANY($${params.length})`); }
    if (f.environmentId) { params.push(f.environmentId); where.push(`environment_id = $${params.length}`); }
    if (f.q) { params.push(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`); where.push(`name ILIKE $${params.length}`); }
    if (f.includePreviews !== '1') where.push('parent_service_id IS NULL');
    const rows = await q(`SELECT * FROM services WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);
    return { items: rows.map(ser.service), nextCursor: null };
  });

  app.post('/workspaces/:ws/services', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const input = CreateService.parse(req.body);
    const { service, deploy } = await createService({ workspaceId: ws, actorId: requireUser(req).id, input });
    return reply.status(201).send({ service: ser.service(service), deploy: deploy && ser.deploy(deploy) });
  });

  app.get('/services/:id', async (req) => ser.service((await svcFor(req)).svc));

  app.patch('/services/:id', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    const body = UpdateService.parse(req.body);
    const next = { ...svc };
    const sets: string[] = [];
    const params: unknown[] = [svc.id];
    for (const [k, v] of Object.entries(body)) {
      const col = COLUMN[k];
      if (!col || v === undefined) continue;
      let value: unknown = v;
      if (k === 'repoUrl' && v) value = validateRepoUrl(v as string);
      if (k === 'cronSchedule' && v) validateCron(v as string);
      if (k === 'healthCheckPath' && v && !(v as string).startsWith('/')) throw badRequest('healthCheckPath must start with /');
      if (k === 'rootDir' && typeof v === 'string' && (v.includes('..') || /^[/\\]/.test(v))) throw badRequest('rootDir must be relative');
      if (k === 'disk') validateDisk(v as never);
      if (k === 'registryCredentialId' && v && !(await one('SELECT 1 FROM registry_credentials WHERE id = $1 AND workspace_id = $2', [v, svc.workspace_id]))) throw badRequest('unknown registry credential');
      if ((k === 'ipAllowList' || k === 'edgeCache') && svc.type !== 'web' && svc.type !== 'static') throw badRequest(`${k} applies to web services and static sites`);
      next[col] = value;
      params.push(JSON_COLS.has(col) ? JSON.stringify(value) : value);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return ser.service(svc);
    if (svc.type !== 'static') validatePlan(next.plan, next.instance_count, next.disk);
    if (next.autoscaling?.enabled) {
      if (next.disk) throw badRequest('autoscaling is unavailable for services with a disk');
      if (next.plan === 'free') throw badRequest('autoscaling is unavailable on the free plan');
      if (next.autoscaling.min > next.autoscaling.max) throw badRequest('autoscaling min must be <= max');
    }
    const row = await one(`UPDATE services SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
    const user = requireUser(req);
    if (body.instanceCount !== undefined && body.instanceCount !== svc.instance_count) {
      await serviceOp(row!, 'scale');
      await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: user.id, kind: 'scaled', data: { from: svc.instance_count, to: body.instanceCount } });
    }
    if (body.plan && body.plan !== svc.plan) {
      // Paid plans never sleep: a sleeping service is started on its new plan instead of restarted.
      const woke = body.plan !== 'free' && (await wakeService(svc.id, { reason: 'plan_changed', actorId: user.id }));
      if (!woke) await serviceOp(row!, 'restart');
      await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: user.id, kind: 'plan_changed', data: { from: svc.plan, to: body.plan } });
    }
    if (body.staticRoutes || body.staticHeaders || body.maintenanceMode !== undefined || body.ipAllowList || body.edgeCache) await notify('nav_routes');
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: user.id, kind: 'settings_updated', data: { fields: Object.keys(body) } });
    return ser.service(row!);
  });

  app.delete('/services/:id', async (req, reply) => {
    const { svc } = await svcFor(req, 'admin');
    await markForDeletion(svc, requireUser(req).id);
    return reply.status(204).send();
  });

  // Lifecycle actions ---------------------------------------------------------------
  app.post('/services/:id/suspend', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    if (svc.suspended) throw conflict('service is already suspended');
    const row = await one("UPDATE services SET suspended = true, status = 'suspended', updated_at = now() WHERE id = $1 RETURNING *", [svc.id]);
    await serviceOp(svc, 'stop_service');
    await notify('nav_routes');
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: requireUser(req).id, kind: 'suspended' });
    return ser.service(row!);
  });

  app.post('/services/:id/resume', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    if (!svc.suspended) throw conflict('service is not suspended');
    const row = await one("UPDATE services SET suspended = false, sleeping = false, status = CASE WHEN current_deploy_id IS NULL THEN 'created' ELSE 'deploying' END, updated_at = now() WHERE id = $1 RETURNING *", [svc.id]);
    if (row!.current_deploy_id) await serviceOp(row!, 'scale');
    else await createDeploy(row!, { trigger: 'manual', actorId: requireUser(req).id });
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: requireUser(req).id, kind: 'resumed' });
    return ser.service(row!);
  });

  /** Empties the edge cache for this service (it also empties itself on every deploy). */
  app.post('/services/:id/cache/purge', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    await q('UPDATE services SET cache_epoch = cache_epoch + 1 WHERE id = $1', [svc.id]);
    await notify('nav_routes');
    return { ok: true };
  });

  app.post('/services/:id/restart', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    if (!svc.current_deploy_id || svc.suspended) throw conflict('service has no running deploy');
    // Restarting a sleeping free instance just wakes it.
    if (!(await wakeService(svc.id, { reason: 'restart', actorId: requireUser(req).id }))) await serviceOp(svc, 'restart');
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: requireUser(req).id, kind: 'restarted' });
    return { ok: true };
  });

  app.post('/services/:id/scale', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    const { instanceCount } = z.object({ instanceCount: z.number().int().min(1).max(100) }).parse(req.body);
    if (['cron', 'static', 'workflow'].includes(svc.type)) throw badRequest(`${svc.type} services cannot be scaled`);
    validatePlan(svc.plan, instanceCount, svc.disk);
    const row = await one('UPDATE services SET instance_count = $2, updated_at = now() WHERE id = $1 RETURNING *', [svc.id, instanceCount]);
    await serviceOp(row!, 'scale');
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: requireUser(req).id, kind: 'scaled', data: { from: svc.instance_count, to: instanceCount } });
    return ser.service(row!);
  });

  app.get('/services/:id/instances', async (req) => {
    const { svc } = await svcFor(req);
    const rows = await q("SELECT * FROM instances WHERE service_id = $1 AND (status <> 'stopped' OR stopped_at > now() - interval '1 hour') ORDER BY started_at DESC LIMIT 100", [svc.id]);
    return { items: rows.map(ser.instance), nextCursor: null };
  });

  app.post('/services/:id/deploy-hook/rotate', async (req) => {
    const { svc } = await svcFor(req, 'admin');
    const row = await one('UPDATE services SET deploy_hook_token = $2 WHERE id = $1 RETURNING *', [svc.id, randomBytes(16).toString('hex')]);
    return { deployHookUrl: ser.service(row!).deployHookUrl };
  });

  // Previews ---------------------------------------------------------------------
  app.get('/services/:id/previews', async (req) => {
    const { svc } = await svcFor(req);
    const rows = await q("SELECT * FROM services WHERE parent_service_id = $1 AND status <> 'deleting' ORDER BY created_at DESC", [svc.id]);
    return { items: rows.map(ser.service), nextCursor: null };
  });

  app.post('/services/:id/previews', async (req, reply) => {
    const { svc } = await svcFor(req, 'developer');
    if (svc.parent_service_id) throw badRequest('cannot create a preview of a preview');
    if (!svc.repo_url) throw badRequest('previews require a Git-backed service');
    const body = z.object({ branch: z.string().min(1).max(255), prNumber: z.number().int().positive().optional() }).parse(req.body);
    const res = await createPreview(svc, body.branch, body.prNumber ?? null, requireUser(req).id);
    return reply.status(201).send({ service: ser.service(res.service), deploy: res.deploy && ser.deploy(res.deploy) });
  });

  // Deploys ---------------------------------------------------------------------
  app.get('/services/:id/deploys', async (req) => {
    const { svc } = await svcFor(req);
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const n = Math.min(Number(limit) || 50, 200);
    const rows = await q(
      'SELECT * FROM deploys WHERE service_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT $3',
      [svc.id, cursor ?? null, n],
    );
    return { items: rows.map(ser.deploy), nextCursor: rows.length === n ? rows[rows.length - 1].created_at : null };
  });

  app.post('/services/:id/deploys', async (req, reply) => {
    const { svc } = await svcFor(req, 'developer');
    const body = z.object({ clearCache: z.boolean().optional(), commitSha: z.string().regex(/^[0-9a-f]{7,40}$/).optional() }).parse(req.body ?? {});
    const dep = await createDeploy(svc, { trigger: 'manual', actorId: requireUser(req).id, clearCache: body.clearCache, commitSha: body.commitSha });
    return reply.status(201).send(ser.deploy(dep));
  });

  app.get('/deploys/:id', async (req) => ser.deploy(await deployFor(req)));

  app.post('/deploys/:id/cancel', async (req) => {
    const dep = await deployFor(req, 'developer');
    await cancelDeploy(dep, dep.workspace_id, requireUser(req).id);
    await changed(dep.workspace_id, 'deploy', dep.id, dep.service_id);
    return ser.deploy((await one('SELECT * FROM deploys WHERE id = $1', [dep.id]))!);
  });

  app.post('/deploys/:id/rollback', async (req, reply) => {
    const dep = await deployFor(req, 'developer');
    const svc = await one('SELECT * FROM services WHERE id = $1', [dep.service_id]);
    if (dep.id === svc!.current_deploy_id) throw conflict('this deploy is already live');
    const next = await createDeploy(svc!, { trigger: 'rollback', actorId: requireUser(req).id, rollbackOf: dep.id });
    return reply.status(201).send(ser.deploy(next));
  });

  app.get('/deploys/:id/logs', async (req) => {
    const dep = await deployFor(req);
    return { items: await fetchLogs({ ...(req.query as object), limit: (req.query as { limit?: string }).limit ?? '2000' }, { col: 'deploy_id', value: dep.id }) };
  });

  app.get('/deploys/:id/logs/stream', async (req, reply) => {
    const dep = await deployFor(req);
    (req.query as Record<string, string>).after ??= '0';
    streamLogs(req, reply, { col: 'deploy_id', value: dep.id }, (n) => n.deployId === dep.id, async () => {
      const d = await one('SELECT status FROM deploys WHERE id = $1', [dep.id]);
      return !['queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress'].includes(d?.status);
    });
  });

  // Environment -----------------------------------------------------------------
  const mask = (role: string, vars: { key: string; value: string }[]) => (atLeast(role as never, 'developer') ? vars : vars.map((v) => ({ ...v, value: '***' })));

  async function envChanged(svc: Row, userId: string, deploy: boolean) {
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: userId, kind: 'env_updated' });
    if (deploy && svc.current_deploy_id && !svc.suspended) await createDeploy(svc, { trigger: 'env_change', actorId: userId });
  }

  app.get('/services/:id/env-vars', async (req) => {
    const { svc, role } = await svcFor(req);
    return { items: mask(role, await listEnv('service', svc.id)) };
  });

  app.put('/services/:id/env-vars', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    const body = z.object({ envVars: z.array(EnvVar).max(500), deploy: z.boolean().optional() }).parse(req.body);
    await tx((c) => replaceEnv(c, 'service', svc.id, body.envVars));
    await envChanged(svc, requireUser(req).id, body.deploy ?? true);
    return { items: await listEnv('service', svc.id) };
  });

  app.patch('/services/:id/env-vars', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    const body = z.object({ set: z.array(EnvVar).max(500).optional(), remove: z.array(z.string()).max(500).optional(), deploy: z.boolean().optional() }).parse(req.body);
    await tx((c) => patchEnv(c, 'service', svc.id, body.set ?? [], body.remove ?? []));
    await envChanged(svc, requireUser(req).id, body.deploy ?? true);
    return { items: await listEnv('service', svc.id) };
  });

  app.get('/services/:id/secret-files', async (req) => {
    const { svc, role } = await svcFor(req);
    const files = await listFiles('service', svc.id);
    return { items: atLeast(role, 'developer') ? files : files.map((f) => ({ ...f, content: '***' })) };
  });

  app.put('/services/:id/secret-files', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    const body = z.object({ secretFiles: z.array(SecretFile).max(50), deploy: z.boolean().optional() }).parse(req.body);
    await tx((c) => replaceFiles(c, 'service', svc.id, body.secretFiles));
    await envChanged(svc, requireUser(req).id, body.deploy ?? true);
    return { items: await listFiles('service', svc.id) };
  });

  app.get('/services/:id/env-groups', async (req) => {
    const { svc } = await svcFor(req);
    const rows = await q('SELECT g.id, g.name FROM service_env_groups sg JOIN env_groups g ON g.id = sg.group_id WHERE sg.service_id = $1 ORDER BY g.name', [svc.id]);
    return { items: rows };
  });

  app.put('/services/:id/env-groups', async (req) => {
    const { svc } = await svcFor(req, 'developer');
    const { groupIds } = z.object({ groupIds: z.array(z.string()).max(20) }).parse(req.body);
    const found = await q('SELECT id FROM env_groups WHERE workspace_id = $1 AND id = ANY($2)', [svc.workspace_id, groupIds]);
    if (found.length !== new Set(groupIds).size) throw badRequest('env group not found');
    await tx(async (c) => {
      await c.query('DELETE FROM service_env_groups WHERE service_id = $1', [svc.id]);
      for (const g of new Set(groupIds)) await c.query('INSERT INTO service_env_groups (service_id, group_id) VALUES ($1,$2)', [svc.id, g]);
    });
    await envChanged(svc, requireUser(req).id, true);
    return { ok: true };
  });

  // Logs ---------------------------------------------------------------------------
  app.get('/services/:id/logs', async (req) => {
    const { svc } = await svcFor(req);
    return { items: await fetchLogs(req.query as Record<string, string>, { col: 'service_id', value: svc.id }) };
  });

  app.get('/services/:id/logs/stream', async (req, reply) => {
    const { svc } = await svcFor(req);
    streamLogs(req, reply, { col: 'service_id', value: svc.id }, (n) => n.serviceId === svc.id);
  });

  // Metrics & events ------------------------------------------------------------------
  app.get('/services/:id/metrics', async (req) => {
    const { svc } = await svcFor(req);
    return serviceMetrics(svc, (req.query as { range?: string }).range ?? '1h');
  });

  app.get('/services/:id/events', async (req) => {
    const { svc } = await svcFor(req);
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const n = Math.min(Number(limit) || 50, 200);
    const rows = await q(
      `SELECT e.*, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.service_id = $1 AND ($2::bigint IS NULL OR e.id < $2) ORDER BY e.id DESC LIMIT $3`,
      [svc.id, cursor ? Number(cursor) : null, n],
    );
    return { items: rows.map(ser.event), nextCursor: rows.length === n ? String(rows[rows.length - 1].id) : null };
  });

  // Runs (cron executions + one-off jobs) ------------------------------------------------
  app.get('/services/:id/runs', async (req) => {
    const { svc } = await svcFor(req);
    const rows = await q('SELECT * FROM runs WHERE service_id = $1 ORDER BY created_at DESC LIMIT 100', [svc.id]);
    return { items: rows.map(ser.run), nextCursor: null };
  });

  app.post('/services/:id/runs', async (req, reply) => {
    const { svc } = await svcFor(req, 'developer');
    const body = z.object({ command: z.string().min(1).max(4096).optional() }).parse(req.body ?? {});
    if (!svc.current_deploy_id) throw conflict('service has not been deployed successfully yet');
    if (svc.type === 'static') throw badRequest('static sites cannot run jobs');
    const command = body.command ?? (svc.type === 'cron' ? svc.start_command : null);
    if (!command && !(svc.type === 'cron' && ['docker', 'image'].includes(svc.runtime))) throw badRequest('command is required');
    const runId = id('run');
    const kind = body.command ? 'job' : 'cron';
    const row = await one(
      "INSERT INTO runs (id, service_id, deploy_id, kind, command, trigger) VALUES ($1,$2,$3,$4,$5,'manual') RETURNING *",
      [runId, svc.id, svc.current_deploy_id, kind, command ?? '(image default command)'],
    );
    await enqueue('run', { runId, serviceId: svc.id });
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: requireUser(req).id, kind: kind === 'job' ? 'job_started' : 'cron_triggered', data: { runId } });
    return reply.status(201).send(ser.run(row!));
  });

  const runFor = async (req: FastifyRequest, min: 'viewer' | 'developer' = 'viewer') => {
    const run = await one('SELECT r.*, s.workspace_id FROM runs r JOIN services s ON s.id = r.service_id WHERE r.id = $1', [(req.params as { id: string }).id]);
    if (!run) throw notFound('run');
    await workspaceRole(req, run.workspace_id, min).catch(() => { throw notFound('run'); });
    return run;
  };

  app.get('/runs/:id', async (req) => ser.run(await runFor(req)));

  app.post('/runs/:id/cancel', async (req) => {
    const run = await runFor(req, 'developer');
    if (!['pending', 'running'].includes(run.status)) throw conflict(`run is ${run.status}`);
    const row = await one("UPDATE runs SET status = 'canceled', finished_at = now() WHERE id = $1 RETURNING *", [run.id]);
    await changed(run.workspace_id, 'run', run.id, run.service_id);
    return ser.run(row!);
  });

  app.get('/runs/:id/logs', async (req) => {
    const run = await runFor(req);
    return { items: await fetchLogs({ ...(req.query as object), limit: '2000' }, { col: 'run_id', value: run.id }) };
  });

  // Custom domains -------------------------------------------------------------------
  app.get('/services/:id/custom-domains', async (req) => {
    const { svc } = await svcFor(req);
    const rows = await q('SELECT * FROM custom_domains WHERE service_id = $1 ORDER BY created_at', [svc.id]);
    return { items: rows.map((r) => ser.domain(r, svc.slug)) };
  });

  app.post('/services/:id/custom-domains', async (req, reply) => {
    const { svc } = await svcFor(req, 'admin');
    if (!['web', 'static'].includes(svc.type)) throw badRequest('only web services and static sites can have custom domains');
    const domain = z.object({ domain: z.string().trim().toLowerCase().max(253) }).parse(req.body).domain.replace(/\.$/, '');
    if (!DOMAIN_RE.test(domain)) throw badRequest('invalid domain name');
    if (domain.endsWith(`.${svc.slug}`) || domain.endsWith(`.${(await import('@nav/shared/config')).config.appsDomain}`)) throw badRequest('cannot use a NAV-managed domain');
    const created: Row[] = [];
    await tx(async (c) => {
      const ins = await c.query('INSERT INTO custom_domains (id, service_id, domain) VALUES ($1,$2,$3) RETURNING *', [id('cdm'), svc.id, domain]);
      created.push(ins.rows[0]);
      // Apex domains get a www. redirect (and vice versa), like most hosting platforms.
      const labels = domain.split('.');
      if (!domain.startsWith('*.') && labels.length === 2) {
        const www = `www.${domain}`;
        const exists = await c.query('SELECT 1 FROM custom_domains WHERE domain = $1', [www]);
        if (!exists.rowCount) {
          const r = await c.query('INSERT INTO custom_domains (id, service_id, domain, redirect_to) VALUES ($1,$2,$3,$4) RETURNING *', [id('cdm'), svc.id, www, domain]);
          created.push(r.rows[0]);
        }
      }
    });
    await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: requireUser(req).id, kind: 'domain_added', data: { domain } });
    for (const d of created) await enqueue('verify_domain', { domainId: d.id }, { maxAttempts: 1 });
    return reply.status(201).send({ items: created.map((r) => ser.domain(r, svc.slug)) });
  });

  const domainFor = async (req: FastifyRequest) => {
    const d = await one('SELECT d.*, s.workspace_id, s.slug FROM custom_domains d JOIN services s ON s.id = d.service_id WHERE d.id = $1', [(req.params as { id: string }).id]);
    if (!d) throw notFound('custom domain');
    await workspaceRole(req, d.workspace_id, 'admin').catch((e) => { throw e.status === 403 ? e : notFound('custom domain'); });
    return d;
  };

  app.post('/custom-domains/:id/verify', async (req) => {
    const d = await domainFor(req);
    const { verifyDomain } = await import('../../lib/domains.ts');
    await verifyDomain(d.id);
    const row = await one('SELECT * FROM custom_domains WHERE id = $1', [d.id]);
    return ser.domain(row!, d.slug);
  });

  app.delete('/custom-domains/:id', async (req, reply) => {
    const d = await domainFor(req);
    await q('DELETE FROM custom_domains WHERE id = $1 OR (redirect_to = $2 AND service_id = $3)', [d.id, d.domain, d.service_id]);
    await q('DELETE FROM certificates WHERE domain = $1', [d.domain]);
    await notify('nav_routes');
    await recordEvent({ workspaceId: d.workspace_id, serviceId: d.service_id, actorId: requireUser(req).id, kind: 'domain_removed', data: { domain: d.domain } });
    return reply.status(204).send();
  });
}
