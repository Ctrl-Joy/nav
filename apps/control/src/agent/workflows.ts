// Workflow execution on a node: task discovery at deploy time and one execution of a run per `workflow_run` job.
// The protocol with the SDK (packages/workflows/index.js): NAV_WORKFLOW_MODE selects describe / run, the run's
// invocation is a file next to the service's secret files, and the result comes back on stdout as base64 chunks
// between `::nav-workflow:` marker lines, which are kept out of the run's logs.
import { id } from '@nav/shared/ids';
import { one, q, tx, type Row } from '../db/pool.ts';
import { changed } from '../lib/core.ts';
import {
  MAX_DEPTH, MAX_STEPS_PER_RUN, afterTerminal, attemptFailed, enqueueRun, parseDescribe, stepsResolved, type DiscoveredTask,
} from '../lib/workflows.ts';
import { startOneOff, type Ctx } from './handlers.ts';
import type { Artifact } from './runtime/types.ts';
import { flushLogs, shipLog, sleep } from './util.ts';

export const INVOCATION_FILE = 'nav-workflow-invocation.json';
const MARK = /^::nav-workflow:(\d+):([A-Za-z0-9+/=]*)$/;
const END = /^::nav-workflow-end::\d+$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DESCRIBE_TIMEOUT_MS = 2 * 60_000;

type Log = (line: string, level?: string) => void;

interface Invoked { result: any | null; code: number; timedOut: boolean }

/** Starts the build once in `mode` and collects the SDK's result from its output. */
async function invoke(ctx: Ctx, svc: Row, deploy: Row, artifact: Artifact, mode: 'describe' | 'run', invocation: object | null, log: Log, signal: AbortSignal, timeoutMs: number, instanceId?: string): Promise<Invoked> {
  const chunks: string[] = [];
  let ended = false;
  const onLine: Log = (line, level) => {
    const m = MARK.exec(line.trim());
    if (m) chunks[Number(m[1])] = m[2];
    else if (END.test(line.trim())) ended = true;
    else log(line, level);
  };
  const handle = await startOneOff(ctx, svc, deploy, artifact, null, onLine, {
    env: { NAV_WORKFLOW_MODE: mode },
    files: invocation ? [{ filename: INVOCATION_FILE, content: JSON.stringify(invocation) }] : [],
    instanceId,
  });
  let timedOut = false;
  const stop = () => void handle.stop(3000);
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  let code: number;
  try {
    code = await handle.exited;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
  // Output can still be draining when the exit is reported.
  if (!timedOut && !signal.aborted) for (let i = 0; !ended && i < 100; i++) await sleep(20);
  if (ctx.driver.name === 'docker') await handle.stop(1000).catch(() => {});
  let result = null;
  if (ended) {
    try {
      result = JSON.parse(Buffer.from(chunks.join(''), 'base64').toString('utf8'));
    } catch {
      log('==> Could not decode the result printed by the workflow SDK', 'error');
    }
  }
  return { result, code, timedOut };
}

/** Deploy time: runs the build in describe mode and returns the tasks it registers. */
export async function discoverTasks(ctx: Ctx, svc: Row, deploy: Row, artifact: Artifact, log: Log, signal: AbortSignal): Promise<DiscoveredTask[]> {
  const r = await invoke(ctx, svc, deploy, artifact, 'describe', null, log, signal, DESCRIBE_TIMEOUT_MS);
  if (r.timedOut) throw new Error(`the start command did not report its tasks within ${DESCRIBE_TIMEOUT_MS / 1000}s`);
  if (!r.result) throw new Error(`the start command exited with code ${r.code} without reporting tasks; does it import @nav/workflows and register tasks?`);
  if (r.result.status === 'failed') throw new Error(r.result.error?.message ?? 'describe failed');
  return parseDescribe(r.result);
}

/** The journal as the SDK expects it: each step with its child's outcome (or whether the sleep is due). */
async function journal(runId: string): Promise<object[]> {
  const rows = await q(
    `SELECT s.seq, s.kind, s.task, s.child_run_id, s.until <= now() AS due, c.status AS child_status, c.output, c.error
     FROM workflow_steps s LEFT JOIN workflow_runs c ON c.id = s.child_run_id WHERE s.run_id = $1 ORDER BY s.seq`,
    [runId],
  );
  return rows.map((s) => {
    if (s.kind === 'sleep') return { seq: s.seq, kind: 'sleep', status: s.due ? 'succeeded' : 'pending' };
    const status = !s.child_status ? 'failed' : ['succeeded', 'failed', 'canceled'].includes(s.child_status) ? s.child_status : 'pending';
    return {
      seq: s.seq, kind: 'run', task: s.task, runId: s.child_run_id, status,
      ...(status === 'succeeded' ? { output: s.output ?? null } : {}),
      ...(status === 'failed' || status === 'canceled' ? { error: { message: s.child_status ? (s.error ?? status) : 'the subtask run no longer exists' } } : {}),
    };
  });
}

/** Records the steps a suspended execution asked for: child runs and sleeps. The run waits for them. */
async function suspend(run: Row, svc: Row, steps: any[], log: Log): Promise<void> {
  if (!Array.isArray(steps)) return void (await attemptFailed(run, 'the SDK reported an invalid suspension', false));
  const existing = await q('SELECT seq FROM workflow_steps WHERE run_id = $1', [run.id]);
  const known = new Set(existing.map((s) => s.seq));
  const fresh = steps.filter((s) => s && Number.isInteger(s.seq) && s.seq > 0 && !known.has(s.seq));
  if (existing.length + fresh.length > MAX_STEPS_PER_RUN) return void (await attemptFailed(run, `a run may have at most ${MAX_STEPS_PER_RUN} subtasks and sleeps`, false));
  if (fresh.some((s) => s.kind === 'run') && run.depth + 1 > MAX_DEPTH) return void (await attemptFailed(run, `subtasks may nest at most ${MAX_DEPTH} levels deep`, false));
  const defs = new Map((await q('SELECT * FROM workflow_tasks WHERE deploy_id = $1', [run.deploy_id])).map((t) => [t.name, t]));
  const sleeps: number[] = [];
  const children: string[] = [];
  const ok = await tx(async (c) => {
    const cur = await c.query('SELECT status FROM workflow_runs WHERE id = $1 FOR UPDATE', [run.id]);
    if (cur.rows[0]?.status !== 'running') return false;
    for (const s of fresh) {
      if (s.kind === 'sleep') {
        const ms = Math.min(Math.max(0, Number(s.ms) || 0), 366 * 86_400_000);
        await c.query("INSERT INTO workflow_steps (run_id, seq, kind, until) VALUES ($1,$2,'sleep', now() + make_interval(secs => $3))", [run.id, s.seq, ms / 1000]);
        sleeps.push(ms);
        continue;
      }
      if (s.kind !== 'run' || typeof s.task !== 'string') continue;
      const def = defs.get(s.task);
      const childId = id('wfr');
      const input = JSON.stringify(s.input ?? null);
      await c.query(
        `INSERT INTO workflow_runs (id, service_id, deploy_id, task, status, input, error, max_attempts, timeout_s, backoff_s, max_backoff_s,
           parent_run_id, root_run_id, depth, trigger, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'subtask', CASE WHEN $5 = 'failed' THEN now() END)`,
        [childId, run.service_id, run.deploy_id, s.task, def ? 'queued' : 'failed', input,
          def ? null : `task "${s.task}" is not registered in this build`, def ? def.retries + 1 : 1, def?.timeout_s ?? 3600, def?.backoff_s ?? 5, def?.max_backoff_s ?? 600,
          run.id, run.root_run_id ?? run.id, run.depth + 1],
      );
      await c.query("INSERT INTO workflow_steps (run_id, seq, kind, task, child_run_id) VALUES ($1,$2,'run',$3,$4)", [run.id, s.seq, s.task, childId]);
      if (def) await enqueueRun(childId, run.service_id, { client: c });
      children.push(`${s.task} (${childId})`);
    }
    await c.query(
      `UPDATE workflow_runs SET status = 'waiting', updated_at = now(),
         wake_at = (SELECT min(until) FROM workflow_steps WHERE run_id = $1 AND kind = 'sleep' AND until > now()) WHERE id = $1`,
      [run.id],
    );
    return true;
  });
  if (!ok) return;
  if (children.length) log(`==> Waiting for ${children.length} subtask${children.length === 1 ? '' : 's'}: ${children.join(', ')}`);
  for (const ms of sleeps) {
    log(`==> Sleeping for ${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
    await enqueueRun(run.id, run.service_id, { runAt: new Date(Date.now() + ms) });
  }
  // Everything may already be resolved (an unknown subtask fails at once, a zero sleep is due now).
  if (await one(`SELECT 1 FROM workflow_runs r WHERE r.id = $1 AND r.status = 'waiting' AND ${stepsResolved('r')}`, [run.id])) await enqueueRun(run.id, run.service_id);
  await changed(svc.workspace_id, 'workflow_run', run.id, svc.id);
}

/** One execution of a run: a new attempt (queued -> running) or a resume after its steps resolved. */
export async function handleWorkflowRun(ctx: Ctx, payload: { runId: string }): Promise<void> {
  const run = await one(
    `WITH prev AS (SELECT id, status FROM workflow_runs WHERE id = $1 FOR UPDATE)
     UPDATE workflow_runs r SET status = 'running', attempts = r.attempts + CASE WHEN prev.status = 'queued' THEN 1 ELSE 0 END,
       started_at = COALESCE(r.started_at, now()), attempt_started_at = now(), next_attempt_at = NULL, wake_at = NULL, updated_at = now()
     FROM prev WHERE r.id = prev.id
       AND ((prev.status = 'queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now() + interval '1 second'))
         OR (prev.status = 'waiting' AND ${stepsResolved('r')}))
     RETURNING r.*, prev.status AS prev_status`,
    [payload.runId],
  );
  if (!run) return;
  const resume = run.prev_status === 'waiting';
  const svc = await one('SELECT * FROM services WHERE id = $1', [run.service_id]);
  const log: Log = (l, level = 'info') => shipLog({ serviceId: run.service_id, runId: run.id, stream: 'workflow' }, l, level);
  if (!svc) return;
  await changed(svc.workspace_id, 'workflow_run', run.id, svc.id);
  const deploy = run.deploy_id ? await one('SELECT * FROM deploys WHERE id = $1', [run.deploy_id]) : null;
  if (!deploy?.artifact || svc.status === 'deleting') {
    log('==> The build this run belongs to no longer exists', 'error');
    await attemptFailed(run, 'the build this run belongs to no longer exists', false);
    await flushLogs();
    return;
  }

  const execution: Record<string, unknown> = { attempt: run.attempts, kind: resume ? 'resume' : 'start', startedAt: new Date().toISOString(), finishedAt: null, outcome: null, error: null };
  log(resume ? `==> Resuming ${run.task} (attempt ${run.attempts}/${run.max_attempts})` : `==> Starting ${run.task} (attempt ${run.attempts}/${run.max_attempts})`);
  const abort = new AbortController();
  const poll = setInterval(async () => {
    const r = await one('SELECT status FROM workflow_runs WHERE id = $1', [run.id]).catch(() => undefined);
    if (r === null || r?.status === 'canceled') abort.abort();
  }, 1000);
  const timeoutMs = Number(run.timeout_s) * 1000;
  let invoked: Invoked = { result: null, code: -1, timedOut: false };
  let startError: string | null = null;
  try {
    const invocation = { task: run.task, input: run.input ?? null, runId: run.id, attempt: run.attempts, steps: await journal(run.id) };
    invoked = await invoke(ctx, svc, deploy, deploy.artifact, 'run', invocation, log, abort.signal, timeoutMs, `wf-${run.id.slice(4)}-${id('x').slice(2, 8)}`);
  } catch (err) {
    startError = (err as Error).message;
  } finally {
    clearInterval(poll);
  }

  const result = invoked.result;
  const record = async (outcome: string, error: string | null = null) => {
    Object.assign(execution, { finishedAt: new Date().toISOString(), outcome, error: error?.slice(0, 1000) ?? null });
    await q('UPDATE workflow_runs SET executions = executions || $2::jsonb WHERE id = $1', [run.id, JSON.stringify([execution])]);
  };
  const failed = async (outcome: string, message: string, retryable: boolean) => {
    await record(outcome, message);
    const delay = await attemptFailed(run, message, retryable);
    if (delay !== null) log(`==> Attempt ${run.attempts} failed: ${message}. Retrying in ${delay < 10 ? delay.toFixed(1) : Math.round(delay)}s`, 'warn');
    else log(`==> Run failed: ${message}`, 'error');
  };

  const now = await one('SELECT status FROM workflow_runs WHERE id = $1', [run.id]);
  if (abort.signal.aborted || now?.status !== 'running') {
    log('==> Run canceled', 'warn');
    await record('canceled');
  } else if (invoked.timedOut) {
    await failed('timed_out', `timed out after ${Number(run.timeout_s)}s`, true);
  } else if (startError) {
    await failed('failed', `could not start: ${startError}`, true);
  } else if (!result) {
    await failed('failed', `the process exited with code ${invoked.code} without reporting a result`, true);
  } else if (result.status === 'succeeded') {
    const output = JSON.stringify(result.output ?? null);
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
      await failed('failed', 'the task result is larger than 1 MB', false);
    } else {
      const row = await one(
        "UPDATE workflow_runs SET status = 'succeeded', output = $2, error = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
        [run.id, output],
      );
      await record('succeeded');
      if (row) {
        log(`==> Succeeded after ${((Date.now() - new Date(run.started_at).getTime()) / 1000).toFixed(1)}s`);
        await afterTerminal(row);
      }
    }
  } else if (result.status === 'suspended') {
    await record('suspended');
    await suspend(run, svc, result.steps, log);
  } else if (result.status === 'failed') {
    const e = result.error ?? {};
    if (e.stack) for (const line of String(e.stack).split('\n').slice(0, 30)) log(line, 'error');
    const message = `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message ?? 'task failed'}`;
    await failed('failed', message, result.retryable !== false);
  } else {
    await failed('failed', `unexpected result from the workflow SDK (${String(result.status)})`, false);
  }
  await changed(svc.workspace_id, 'workflow_run', run.id, svc.id);
  await flushLogs();
}
