// Sandboxes: isolated, short-lived environments where code (for example from AI agents) is executed via the API.
//   GET    /sandbox-plans
//   GET    /workspaces/:ws/sandboxes?status=live|all       POST /workspaces/:ws/sandboxes
//   GET    /sandboxes/:id                                  DELETE /sandboxes/:id
//   POST   /sandboxes/:id/exec                             (streaming: WS /sandboxes/:id/exec/stream, see http/sandboxRelay.ts)
//   PUT|GET|DELETE /sandboxes/:id/files?path=              GET /sandboxes/:id/ls?path=
//   POST   /sandboxes/:id/snapshots                        GET /workspaces/:ws/sandbox-snapshots
//   GET    /sandbox-snapshots/:id                          DELETE /sandbox-snapshots/:id
// Viewers can list and inspect; developers create, run commands, move files and snapshot. Every exec is audited
// with its command and exit code (never its output).
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id } from '@nav/shared/ids';
import { SANDBOX_IMAGES, SANDBOX_LIMITS, SANDBOX_PLANS, type Role, type SandboxExecResult } from '@nav/shared';
import { one, q, tx, type Row } from '../../db/pool.ts';
import { HttpError, badRequest, conflict, notFound } from '../../lib/core.ts';
import {
  LIVE, agentError, agentFetch, agentJson, deleteSnapshotArchive, nodeOf, placeSandbox, redactCommand, sandboxOut, sandboxSnapshotOut, teardownSandbox,
  type AgentNode,
} from '../../lib/sandboxes.ts';
import { sandboxImageError } from '../../lib/sandboxImages.ts';
import { requireUser, workspaceRole } from '../auth.ts';
import { writeAudit } from './audit.ts';

const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env var names are letters, digits and _').max(128);
const Env = z.record(EnvKey, z.string().max(32 * 1024)).refine((e) => Object.keys(e).length <= SANDBOX_LIMITS.maxEnvVars, `at most ${SANDBOX_LIMITS.maxEnvVars} env vars`);
// Images are references like python:3.13-slim or ghcr.io/org/img@sha256:...; no flags, spaces or shell syntax.
// Only the platform defaults and operator-allowlisted repositories (NAV_SANDBOX_IMAGES) are accepted, never NAV
// build images or bare image IDs: the node always pulls the image, so nothing comes from its local cache.
const Image = z.string().trim().max(255).regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, 'not a valid image reference')
  .superRefine((v, ctx) => { const err = sandboxImageError(v); if (err) ctx.addIssue({ code: 'custom', message: err }); });

const CreateBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  runtime: z.enum(['node', 'python', 'bash']).optional(),
  image: Image.optional(),
  plan: z.string().default('small'),
  ttlSeconds: z.number().int().min(SANDBOX_LIMITS.minTtlSeconds).max(SANDBOX_LIMITS.maxTtlSeconds).default(SANDBOX_LIMITS.defaultTtlSeconds),
  env: Env.default({}),
  networkAccess: z.enum(['none', 'egress']).default('none'),
  snapshotId: z.string().max(64).optional(),
});

const ExecBody = z.object({
  command: z.string().min(1).refine((c) => Buffer.byteLength(c) <= SANDBOX_LIMITS.maxCommandBytes, 'command is too long'),
  cwd: z.string().max(4096).default(''),
  env: Env.default({}),
  timeoutSeconds: z.number().int().min(1).max(SANDBOX_LIMITS.maxExecTimeoutSeconds).default(SANDBOX_LIMITS.defaultExecTimeoutSeconds),
  stdin: z.string().refine((s) => Buffer.byteLength(s) <= SANDBOX_LIMITS.maxStdinBytes, 'stdin is too large').nullable().optional(),
});

const PathQuery = z.object({ path: z.string().max(4096).default('') });

/** Loads a sandbox and checks the caller's role in its workspace; 404 hides other workspaces' sandboxes. */
async function sandboxFor(req: FastifyRequest, min: Role = 'viewer'): Promise<Row> {
  const sb = await one('SELECT * FROM sandboxes WHERE id = $1', [(req.params as { id: string }).id]);
  if (!sb) throw notFound('sandbox');
  await workspaceRole(req, sb.workspace_id, min).catch((err) => { throw err.status === 403 ? err : notFound('sandbox'); });
  return sb;
}

/** A sandbox that can take commands now, and the node that runs it. Past its TTL it is torn down on the spot. */
export async function liveSandbox(sb: Row): Promise<AgentNode> {
  if (sb.status === 'running' && new Date(sb.expires_at).getTime() <= Date.now()) {
    await teardownSandbox(sb, 'expired');
    throw new HttpError(409, 'sandbox_expired', 'the sandbox has expired');
  }
  if (sb.status !== 'running') throw new HttpError(409, 'sandbox_not_running', `the sandbox is ${sb.status}`);
  const node = await nodeOf(sb);
  if (!node) throw new HttpError(409, 'sandbox_not_running', 'the node running this sandbox is gone');
  return node;
}

export async function sandboxRoutes(app: FastifyInstance) {
  // File uploads are raw bytes. JSON-typed uploads were already parsed by the app's JSON parser: use its raw body.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: SANDBOX_LIMITS.maxFileBytes }, (_req, body, done) => done(null, body));

  app.get('/sandbox-plans', async () => ({ plans: SANDBOX_PLANS, images: SANDBOX_IMAGES, limits: SANDBOX_LIMITS }));

  app.get('/workspaces/:ws/sandboxes', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const { status } = z.object({ status: z.enum(['live', 'all']).default('all') }).parse(req.query);
    const rows = await q(
      `SELECT * FROM sandboxes WHERE workspace_id = $1 AND ($2 = 'all' OR status = ANY($3)) ORDER BY created_at DESC LIMIT 200`,
      [ws, status, LIVE],
    );
    return { items: rows.map(sandboxOut) };
  });

  app.post('/workspaces/:ws/sandboxes', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const user = requireUser(req);
    const body = CreateBody.parse(req.body);
    const plan = SANDBOX_PLANS.find((p) => p.id === body.plan);
    if (!plan) throw badRequest(`unknown plan; one of ${SANDBOX_PLANS.map((p) => p.id).join(', ')}`);

    let snapshot: Row | null = null;
    if (body.snapshotId) {
      snapshot = await one('SELECT * FROM sandbox_snapshots WHERE id = $1 AND workspace_id = $2', [body.snapshotId, ws]);
      if (!snapshot) throw notFound('snapshot');
      if (snapshot.status !== 'completed' || !snapshot.store) throw badRequest(`snapshot is ${snapshot.status}`);
    }
    const runtime = body.runtime ?? (body.image ? null : snapshot?.runtime ?? 'bash');
    const image = body.image ?? snapshot?.image ?? SANDBOX_IMAGES[runtime as keyof typeof SANDBOX_IMAGES];
    const imageError = sandboxImageError(image);
    if (imageError) throw badRequest(imageError);

    const node = await placeSandbox();
    if (!node) throw new HttpError(503, 'no_capacity', 'no node is available to run sandboxes');
    const sandboxId = id('sbx');
    // The limit check and the insert happen under a per-workspace lock, so concurrent creates cannot overshoot.
    const row = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(77020, hashtext($1))', [ws]);
      const { rows: [lim] } = await c.query(
        `SELECT COALESCE(w.sandbox_limit, $2) AS max, (SELECT count(*)::int FROM sandboxes s WHERE s.workspace_id = w.id AND s.status = ANY($3)) AS live
         FROM workspaces w WHERE w.id = $1`,
        [ws, SANDBOX_LIMITS.maxPerWorkspace, LIVE],
      );
      if (lim.live >= lim.max) throw new HttpError(429, 'sandbox_limit', `this workspace already has ${lim.live} live sandboxes (limit ${lim.max}); delete one first`);
      const { rows } = await c.query(
        `INSERT INTO sandboxes (id, workspace_id, name, runtime, image, plan, network_access, node_id, env_keys, from_snapshot_id, ttl_seconds, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::int, now() + make_interval(secs => $11::int), $12) RETURNING *`,
        [sandboxId, ws, body.name ?? null, runtime, image, plan.id, body.networkAccess, node.id, Object.keys(body.env), snapshot?.id ?? null, body.ttlSeconds, user.id],
      );
      return rows[0];
    });

    const res = await agentFetch(node, 'POST', '/sandboxes', {
      json: { spec: { id: sandboxId, workspaceId: ws, image, runtime, plan, env: body.env, networkAccess: body.networkAccess }, snapshot: snapshot?.store ?? null },
      timeoutMs: 10 * 60_000,
    }).catch((err: Error) => err);
    if (res instanceof Error || !res.ok) {
      const err = res instanceof Error ? res : await agentError(res);
      await q("UPDATE sandboxes SET status = 'failed', error = $2, stopped_at = now() WHERE id = $1", [sandboxId, err.message.slice(0, 500)]);
      throw err instanceof HttpError && err.status !== 404 ? err : new HttpError(502, 'sandbox_failed', `the sandbox could not be started: ${err.message}`);
    }
    const started = (await res.json()) as { driver: string; egressFiltered?: boolean };
    const live = await one("UPDATE sandboxes SET status = 'running', driver = $2, egress_filtered = $3 WHERE id = $1 AND status = 'starting' RETURNING *", [sandboxId, started.driver, started.egressFiltered === true]);
    return reply.status(201).send(sandboxOut(live ?? row));
  });

  app.get('/sandboxes/:id', async (req) => sandboxOut(await sandboxFor(req)));

  app.delete('/sandboxes/:id', async (req, reply) => {
    const sb = await sandboxFor(req, 'developer');
    if (LIVE.includes(sb.status) || sb.status === 'failed') await teardownSandbox(sb, 'stopped');
    return reply.status(204).send();
  });

  app.post('/sandboxes/:id/exec', async (req) => {
    const sb = await sandboxFor(req, 'developer');
    const body = ExecBody.parse(req.body);
    const node = await liveSandbox(sb);
    await q('UPDATE sandboxes SET exec_count = exec_count + 1, last_exec_at = now() WHERE id = $1', [sb.id]);
    let result: SandboxExecResult | null = null;
    try {
      result = await agentJson<SandboxExecResult>(node, 'POST', `/sandboxes/${sb.id}/exec`, { json: body, timeoutMs: (body.timeoutSeconds + 30) * 1000 });
      return result;
    } finally {
      req.auditSkip = true;
      const user = requireUser(req);
      await writeAudit({
        workspaceId: sb.workspace_id, actorId: user.id, actorEmail: user.email, actorKind: req.authKind ?? 'session', action: 'sandbox.exec',
        targetType: 'sandboxes', targetId: sb.id, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''),
        data: { command: redactCommand(body.command).slice(0, 4096), cwd: body.cwd || null, exitCode: result?.exitCode ?? null, timedOut: result?.timedOut ?? false, failed: result === null, mode: 'sync' },
      });
    }
  });

  app.put('/sandboxes/:id/files', { bodyLimit: SANDBOX_LIMITS.maxFileBytes }, async (req) => {
    const sb = await sandboxFor(req, 'developer');
    const { path, mode } = PathQuery.extend({ mode: z.string().regex(/^[0-7]{3,4}$/).optional() }).parse(req.query);
    if (!path) throw badRequest('path is required');
    const node = await liveSandbox(sb);
    const data = Buffer.isBuffer(req.body) ? req.body : ((req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0));
    return agentJson<{ size: number }>(node, 'PUT', `/sandboxes/${sb.id}/files`, { body: data, query: { path, ...(mode ? { mode } : {}) }, timeoutMs: 5 * 60_000 });
  });

  app.get('/sandboxes/:id/files', async (req, reply: FastifyReply) => {
    const sb = await sandboxFor(req, 'developer');
    const { path } = PathQuery.parse(req.query);
    if (!path) throw badRequest('path is required');
    const node = await liveSandbox(sb);
    const res = await agentFetch(node, 'GET', `/sandboxes/${sb.id}/files`, { query: { path }, timeoutMs: 5 * 60_000 });
    if (!res.ok || !res.body) throw await agentError(res);
    const name = path.split('/').filter(Boolean).pop() ?? 'file';
    reply.header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`);
    const len = res.headers.get('content-length');
    if (len) reply.header('content-length', len);
    return reply.type('application/octet-stream').send(Readable.fromWeb(res.body as never));
  });

  app.delete('/sandboxes/:id/files', async (req, reply) => {
    const sb = await sandboxFor(req, 'developer');
    const { path, recursive } = PathQuery.extend({ recursive: z.enum(['0', '1', 'true', 'false']).optional() }).parse(req.query);
    if (!path) throw badRequest('path is required');
    const node = await liveSandbox(sb);
    await agentJson(node, 'DELETE', `/sandboxes/${sb.id}/files`, { query: { path, recursive: recursive === '1' || recursive === 'true' ? '1' : '0' } });
    return reply.status(204).send();
  });

  app.get('/sandboxes/:id/ls', async (req) => {
    const sb = await sandboxFor(req, 'developer');
    const { path } = PathQuery.parse(req.query);
    const node = await liveSandbox(sb);
    return agentJson(node, 'GET', `/sandboxes/${sb.id}/ls`, { query: { path } });
  });

  app.post('/sandboxes/:id/snapshots', async (req, reply) => {
    const sb = await sandboxFor(req, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(64).optional() }).parse(req.body ?? {});
    const node = await liveSandbox(sb);
    const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM sandbox_snapshots WHERE workspace_id = $1 AND status <> 'failed'", [sb.workspace_id]);
    if ((count?.n ?? 0) >= SANDBOX_LIMITS.maxSnapshotsPerWorkspace) throw new HttpError(429, 'snapshot_limit', `this workspace has ${count!.n} snapshots (limit ${SANDBOX_LIMITS.maxSnapshotsPerWorkspace}); delete one first`);
    const snapId = id('sbs');
    await q(
      'INSERT INTO sandbox_snapshots (id, workspace_id, sandbox_id, name, runtime, image, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [snapId, sb.workspace_id, sb.id, body.name ?? null, sb.runtime, sb.image, requireUser(req).id],
    );
    try {
      const store = await agentJson<{ key: string; digest: string; size: number }>(node, 'POST', `/sandboxes/${sb.id}/snapshot`, { json: { key: snapId }, timeoutMs: 15 * 60_000 });
      const row = await one("UPDATE sandbox_snapshots SET status = 'completed', store = $2, size_bytes = $3, finished_at = now() WHERE id = $1 RETURNING *", [snapId, store, store.size]);
      return reply.status(201).send(sandboxSnapshotOut(row!));
    } catch (err) {
      await q("UPDATE sandbox_snapshots SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [snapId, (err as Error).message.slice(0, 500)]);
      throw err;
    }
  });

  app.get('/workspaces/:ws/sandbox-snapshots', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const { sandboxId } = z.object({ sandboxId: z.string().max(64).optional() }).parse(req.query);
    const rows = await q('SELECT * FROM sandbox_snapshots WHERE workspace_id = $1 AND ($2::text IS NULL OR sandbox_id = $2) ORDER BY created_at DESC LIMIT 200', [ws, sandboxId ?? null]);
    return { items: rows.map(sandboxSnapshotOut) };
  });

  const snapshotFor = async (req: FastifyRequest, min: Role) => {
    const snap = await one('SELECT * FROM sandbox_snapshots WHERE id = $1', [(req.params as { id: string }).id]);
    if (!snap) throw notFound('snapshot');
    await workspaceRole(req, snap.workspace_id, min).catch((err) => { throw err.status === 403 ? err : notFound('snapshot'); });
    return snap;
  };

  app.get('/sandbox-snapshots/:id', async (req) => sandboxSnapshotOut(await snapshotFor(req, 'viewer')));

  app.delete('/sandbox-snapshots/:id', async (req, reply) => {
    const snap = await snapshotFor(req, 'developer');
    if (snap.status === 'pending') throw conflict('the snapshot is still being taken');
    await deleteSnapshotArchive(snap.id);
    await q('DELETE FROM sandbox_snapshots WHERE id = $1', [snap.id]);
    return reply.status(204).send();
  });
}
