// NAV Workflows: runs of a workflow service's tasks. Shared by the API (create / cancel / retry), the agent
// (attempt bookkeeping) and the scheduler (sweeping runs whose wake-up was lost).
//
// Model (see packages/workflows/index.js for the SDK side):
//  - A run is one call of a task. It moves queued -> running -> succeeded | failed | canceled. Each execution of
//    the task code is a one-off process in the workflow's build, started by a `workflow_run` job.
//  - Failed attempts are retried with exponential backoff (backoff_s * 2^(attempt-1), capped at max_backoff_s)
//    until max_attempts (retries + 1). Timeouts and crashes count as failed attempts.
//  - ctx.run / ctx.sleep are journaled steps (workflow_steps). When the code reaches new steps the execution ends
//    "suspended": the steps are recorded, subtasks become child runs, and the run is 'waiting' (no process, no
//    concurrency slot). When every step is resolved (children finished, sleeps due) a job resumes it: the code
//    runs again from the top and recorded steps return their results immediately (replay).
//  - On a retry, steps whose subtask failed or was canceled are dropped so they run again; succeeded subtasks and
//    finished sleeps are kept, so an attempt never redoes completed child work.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { id } from '@nav/shared/ids';
import { one, q, tx, type Client, type Row } from '../db/pool.ts';
import { HttpError, badRequest, changed, conflict, enqueue, notFound } from './core.ts';

export const RUN_JOB = 'workflow_run';
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_DEPTH = 10;
export const MAX_STEPS_PER_RUN = 1000;
export const ACTIVE = ['queued', 'running', 'waiting'];
export const TERMINAL = ['succeeded', 'failed', 'canceled'];

// --- Service tokens --------------------------------------------------------------------------------
// Every service gets NAV_WORKFLOWS_TOKEN: it may start, read and cancel runs of workflows in its own workspace and
// nothing else. Derived from the master key, so it needs no storage (rotating the master key rotates it).

const TOKEN_PREFIX = 'navwf_';

function tokenSig(workspaceId: string): string {
  const key = process.env.NAV_MASTER_KEY;
  if (!key) throw new Error('NAV_MASTER_KEY must be set');
  return createHmac('sha256', key).update(`nav:workflows-token:v1:${workspaceId}`).digest('base64url');
}

export function workflowsToken(workspaceId: string): string {
  return `${TOKEN_PREFIX}${workspaceId}.${tokenSig(workspaceId)}`;
}

export const isWorkflowsToken = (token: string) => token.startsWith(TOKEN_PREFIX);

/** The workspace a service token belongs to, or null when it is not genuine. */
export function verifyWorkflowsToken(token: string): string | null {
  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (!token.startsWith(TOKEN_PREFIX) || dot < 1) return null;
  const ws = body.slice(0, dot);
  const want = Buffer.from(tokenSig(ws));
  const got = Buffer.from(body.slice(dot + 1));
  return got.length === want.length && timingSafeEqual(got, want) ? ws : null;
}

// --- Tasks -----------------------------------------------------------------------------------------

export async function tasksOf(deployId: string | null): Promise<Row[]> {
  if (!deployId) return [];
  return q('SELECT * FROM workflow_tasks WHERE deploy_id = $1 ORDER BY name', [deployId]);
}

export interface DiscoveredTask { name: string; retries: number; timeoutSeconds: number; backoffSeconds: number; maxBackoffSeconds: number; description: string | null }

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Validates what a build's describe mode printed. */
export function parseDescribe(result: unknown): DiscoveredTask[] {
  const r = result as { status?: string; tasks?: unknown };
  if (!r || r.status !== 'described' || !Array.isArray(r.tasks)) throw new Error('the describe run did not report any tasks');
  const num = (v: unknown, min: number, max: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
  const seen = new Set<string>();
  return r.tasks.slice(0, 500).map((t: any) => {
    if (!t || typeof t.name !== 'string' || !TASK_NAME.test(t.name)) throw new Error(`invalid task name ${JSON.stringify(t?.name)}`);
    if (seen.has(t.name)) throw new Error(`task "${t.name}" is registered twice`);
    seen.add(t.name);
    return {
      name: t.name,
      retries: Math.floor(num(t.retries, 0, 20, 0)),
      timeoutSeconds: num(t.timeoutSeconds, 1, 86_400, 3600),
      backoffSeconds: num(t.backoffSeconds, 0, 3600, 5),
      maxBackoffSeconds: num(t.maxBackoffSeconds, 0, 86_400, 600),
      description: typeof t.description === 'string' ? t.description.slice(0, 500) : null,
    };
  });
}

export async function saveTasks(serviceId: string, deployId: string, tasks: DiscoveredTask[]): Promise<void> {
  await tx(async (c) => {
    await c.query('DELETE FROM workflow_tasks WHERE deploy_id = $1', [deployId]);
    for (const t of tasks) {
      await c.query(
        'INSERT INTO workflow_tasks (deploy_id, service_id, name, retries, timeout_s, backoff_s, max_backoff_s, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [deployId, serviceId, t.name, t.retries, t.timeoutSeconds, t.backoffSeconds, t.maxBackoffSeconds, t.description],
      );
    }
  });
}

// --- Runs --------------------------------------------------------------------------------------------

/** SQL: every journaled step of run `alias` is resolved (its child finished, or its sleep is due). */
export const stepsResolved = (alias: string) => `NOT EXISTS (
  SELECT 1 FROM workflow_steps s LEFT JOIN workflow_runs c ON c.id = s.child_run_id
  WHERE s.run_id = ${alias}.id AND ((s.kind = 'run' AND c.status IN ('queued','running','waiting')) OR (s.kind = 'sleep' AND s.until > now())))`;

export function enqueueRun(runId: string, serviceId: string, opts: { runAt?: Date; client?: Client } = {}): Promise<number> {
  return enqueue(RUN_JOB, { runId, serviceId }, { runAt: opts.runAt, client: opts.client, maxAttempts: 1 });
}

const positive = (v: string | undefined, def: number) => (Number(v) > 0 ? Math.floor(Number(v)) : def);
/** Active (queued, running or waiting) runs a workflow may have at once: bounds fan-out and API floods. */
export const maxActiveRunsPerWorkflow = () => positive(process.env.NAV_WORKFLOW_MAX_ACTIVE_RUNS, 1000);
/** Active runs across all workflows of a workspace. */
export const maxActiveRunsPerWorkspace = () => positive(process.env.NAV_WORKSPACE_MAX_ACTIVE_RUNS, 5000);

export class RunLimitError extends HttpError {
  constructor(message: string) {
    super(429, 'run_limit', message);
  }
}

/**
 * Throws RunLimitError when `adding` more active runs would take the workflow or its workspace past its limit.
 * Runs inside the caller's transaction, under a per-workspace lock, so concurrent creates cannot overshoot.
 */
export async function assertRunCapacity(c: Client, svc: Row, adding: number): Promise<void> {
  if (adding <= 0) return;
  await c.query('SELECT pg_advisory_xact_lock(77030, hashtext($1))', [svc.workspace_id]);
  const { rows: [n] } = await c.query(
    `SELECT (SELECT count(*)::int FROM workflow_runs WHERE service_id = $1 AND status IN ('queued','running','waiting')) AS workflow,
            (SELECT count(*)::int FROM workflow_runs r JOIN services s ON s.id = r.service_id
              WHERE s.workspace_id = $2 AND r.status IN ('queued','running','waiting')) AS workspace`,
    [svc.id, svc.workspace_id],
  );
  const perWorkflow = maxActiveRunsPerWorkflow();
  const perWorkspace = maxActiveRunsPerWorkspace();
  if (n.workflow + adding > perWorkflow) throw new RunLimitError(`this workflow already has ${n.workflow} active runs (limit ${perWorkflow}); wait for some to finish`);
  if (n.workspace + adding > perWorkspace) throw new RunLimitError(`this workspace already has ${n.workspace} active workflow runs (limit ${perWorkspace}); wait for some to finish`);
}

export interface CreateRunRequest {
  task: string;
  input: unknown;
  idempotencyKey?: string | null;
  trigger: string;
  actorId?: string | null;
  retryOf?: string | null;
}

/** Starts a top-level run on the workflow's live deploy. With an idempotency key, a repeat returns the first run. */
export async function createRun(svc: Row, req: CreateRunRequest): Promise<{ run: Row; created: boolean }> {
  if (svc.type !== 'workflow') throw badRequest('this service is not a workflow');
  if (svc.suspended) throw conflict('the workflow is suspended');
  if (!svc.current_deploy_id) throw conflict('the workflow has no live deploy yet');
  const def = await one('SELECT * FROM workflow_tasks WHERE deploy_id = $1 AND name = $2', [svc.current_deploy_id, req.task]);
  if (!def) throw notFound(`task "${req.task}"`);
  const input = req.input === undefined ? null : req.input;
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) throw badRequest('input must be at most 1 MB of JSON');
  const key = req.idempotencyKey || null;
  const runId = id('wfr');
  const created = await tx(async (c) => {
    // A repeated idempotency key returns the first run even at the limit.
    if (key && (await c.query('SELECT 1 FROM workflow_runs WHERE service_id = $1 AND idempotency_key = $2', [svc.id, key])).rows[0]) return null;
    await assertRunCapacity(c, svc, 1);
    const ins = await c.query(
      `INSERT INTO workflow_runs (id, service_id, deploy_id, task, input, max_attempts, timeout_s, backoff_s, max_backoff_s, idempotency_key, trigger, retry_of, created_by, root_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$1)
       ON CONFLICT (service_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
      [runId, svc.id, svc.current_deploy_id, req.task, JSON.stringify(input), def.retries + 1, def.timeout_s, def.backoff_s, def.max_backoff_s, key, req.trigger, req.retryOf ?? null, req.actorId ?? null],
    );
    if (!ins.rows[0]) return null;
    await enqueueRun(runId, svc.id, { client: c });
    return ins.rows[0];
  });
  if (!created) {
    const existing = await one('SELECT * FROM workflow_runs WHERE service_id = $1 AND idempotency_key = $2', [svc.id, key]);
    if (existing!.task !== req.task) throw conflict(`idempotency key "${key}" was already used for task "${existing!.task}"`);
    return { run: existing!, created: false };
  }
  await changed(svc.workspace_id, 'workflow_run', runId, svc.id);
  return { run: created, created: true };
}

async function workspaceOf(serviceId: string): Promise<string | null> {
  return (await one('SELECT workspace_id FROM services WHERE id = $1', [serviceId]))?.workspace_id ?? null;
}

async function notifyRun(row: Row): Promise<void> {
  const ws = await workspaceOf(row.service_id);
  if (ws) await changed(ws, 'workflow_run', row.id, row.service_id);
}

/** A run reached a final state: let its parent (if any) resume once all of its steps are resolved. */
export async function afterTerminal(row: Row): Promise<void> {
  if (row.parent_run_id) await enqueueRun(row.parent_run_id, row.service_id);
  await notifyRun(row);
}

/**
 * Records a failed attempt of a running run: schedules the next attempt with backoff, or fails the run when it is
 * out of attempts (or the failure is not retryable). Returns the delay in seconds when retrying, else null.
 */
export async function attemptFailed(run: Row, message: string, retryable: boolean): Promise<number | null> {
  const error = message.slice(0, 4000);
  if (retryable && run.attempts < run.max_attempts) {
    const delay = Math.min(Number(run.backoff_s) * 2 ** Math.max(0, run.attempts - 1), Number(run.max_backoff_s));
    const row = await one(
      "UPDATE workflow_runs SET status = 'queued', error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [run.id, error, delay],
    );
    if (!row) return null;
    // Failed / canceled subtasks run again on the next attempt; succeeded ones and finished sleeps are replayed.
    await q(
      `DELETE FROM workflow_steps s WHERE s.run_id = $1 AND s.kind = 'run'
         AND NOT EXISTS (SELECT 1 FROM workflow_runs c WHERE c.id = s.child_run_id AND c.status IN ('succeeded','queued','running','waiting'))`,
      [run.id],
    );
    await enqueueRun(run.id, run.service_id, { runAt: new Date(Date.now() + delay * 1000) });
    await notifyRun(row);
    return delay;
  }
  const row = await one(
    "UPDATE workflow_runs SET status = 'failed', error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
    [run.id, error],
  );
  if (row) await afterTerminal(row);
  return null;
}

/** Cancels a run and every unfinished run below it. Returns the ids that were canceled. */
export async function cancelRun(run: Row): Promise<string[]> {
  const rows = await q(
    `WITH RECURSIVE tree AS (
       SELECT id FROM workflow_runs WHERE id = $1
       UNION ALL SELECT r.id FROM workflow_runs r JOIN tree t ON r.parent_run_id = t.id)
     UPDATE workflow_runs SET status = 'canceled', error = COALESCE(error, 'canceled'), finished_at = now(), updated_at = now()
     WHERE id IN (SELECT id FROM tree) AND status IN ('queued','running','waiting') RETURNING id, service_id, parent_run_id`,
    [run.id],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  await q("UPDATE jobs SET status = 'canceled', finished_at = now() WHERE kind = $1 AND status = 'queued' AND payload->>'runId' = ANY($2)", [RUN_JOB, ids]);
  const top = rows.find((r) => r.id === run.id);
  // A canceled subtask fails its ctx.run in the parent (which may catch it).
  if (top?.parent_run_id) await enqueueRun(top.parent_run_id, top.service_id);
  const ws = await workspaceOf(run.service_id);
  if (ws) for (const r of rows) await changed(ws, 'workflow_run', r.id, r.service_id);
  return ids;
}

/** Re-runs a finished top-level run with the same task and input on the live deploy. */
export async function retryRun(svc: Row, run: Row, actorId: string | null): Promise<Row> {
  if (run.parent_run_id) throw badRequest('retry the top-level run instead of a subtask');
  if (!['failed', 'canceled'].includes(run.status)) throw conflict(`run is ${run.status}`);
  return (await createRun(svc, { task: run.task, input: run.input, trigger: 'retry', actorId, retryOf: run.id })).run;
}

/** Per-status run counts of a workflow. */
export async function runCounts(serviceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const r of await q('SELECT status, count(*)::int AS n FROM workflow_runs WHERE service_id = $1 GROUP BY status', [serviceId])) counts[r.status] = r.n;
  return counts;
}

/**
 * Repairs lost wake-ups (scheduler, every few seconds): attempts whose agent vanished count as failed, and queued /
 * resolvable waiting runs without a pending job get one.
 */
export async function sweepWorkflowRuns(): Promise<void> {
  const noJob = (alias: string, statuses: string) =>
    `NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = '${RUN_JOB}' AND j.status IN (${statuses}) AND j.payload->>'runId' = ${alias}.id)`;
  const lost = await q(
    `SELECT r.* FROM workflow_runs r WHERE r.status = 'running' AND r.attempt_started_at < now() - interval '1 minute' AND ${noJob('r', "'running'")}`,
  );
  for (const r of lost) await attemptFailed(r, 'the agent running this attempt stopped responding', true);
  const stalled = await q(
    `SELECT r.id, r.service_id FROM workflow_runs r
     WHERE ((r.status = 'queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())) OR (r.status = 'waiting' AND ${stepsResolved('r')}))
       AND r.updated_at < now() - interval '10 seconds' AND ${noJob('r', "'queued','running'")}
     LIMIT 500`,
  );
  for (const r of stalled) await enqueueRun(r.id, r.service_id);
}
