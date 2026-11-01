// NAV Workflows SDK: define durable tasks in a workflow service and start runs from anywhere.
//
// A workflow service's entry module registers tasks with `task(name, options?, fn)`. NAV runs the built service in
// two modes, selected by NAV_WORKFLOW_MODE:
//   describe  print the registered tasks (at deploy time, so the dashboard and API know them)
//   run       execute one task with the input NAV passes in, and print the result
// Results travel back on stdout as base64 chunks between `::nav-workflow:` marker lines (the agent strips them
// from the run's logs), so any amount of ordinary console output can surround them.
//
// Durability is simple replay. `ctx.run(subtask, input)` and `ctx.sleep(ms)` are numbered steps. The first time
// the task reaches an unfinished step, the process reports the steps it wants and exits ("suspended"); NAV records
// them, runs the subtasks as child runs (or waits out the sleep), then invokes the task again from the start with
// the recorded results. Completed steps return their recorded value immediately, so only new steps do work.
// Code outside ctx.run / ctx.sleep therefore runs once per invocation and must be deterministic and safe to
// repeat (put side effects such as sending email inside a subtask).
//
// Plain JavaScript (with index.d.ts types) so it runs from node_modules without a build step.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SDK_VERSION = '0.1.0';
export const INVOCATION_FILE = 'nav-workflow-invocation.json';

const MARK = '::nav-workflow:';
const END = '::nav-workflow-end::';
const CHUNK = 3000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEFAULTS = { retries: 0, timeoutSeconds: 3600, backoffSeconds: 5, maxBackoffSeconds: 600 };

/** @type {Map<string, { name: string; fn: Function; options: Record<string, unknown> }>} */
const registry = new Map();
let autoStart = null;
let started = false;

// --- Errors ------------------------------------------------------------------------------------------

/** Throw to fail the run immediately, without using any remaining retries. */
export class NonRetryableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'NonRetryableError';
    this.retryable = false;
  }
}

/** Thrown by `ctx.run` when the subtask failed or was canceled. */
export class TaskRunError extends Error {
  constructor(step) {
    super(`subtask "${step.task}" ${step.status === 'canceled' ? 'was canceled' : 'failed'}${step.error?.message ? `: ${step.error.message}` : ''}`);
    this.name = 'TaskRunError';
    this.task = step.task;
    this.runId = step.runId ?? null;
    this.status = step.status;
    this.cause = step.error ?? undefined;
  }
}

/** The task took a different path on replay than on an earlier execution of the same run. */
export class NonDeterminismError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonDeterminismError';
    this.retryable = false;
  }
}

// --- Registration ------------------------------------------------------------------------------------

function number(name, value, min, max) {
  if (value === undefined) return DEFAULTS[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Registers a task. `task(name, fn)` or `task(name, { retries, timeoutSeconds, backoffSeconds, maxBackoffSeconds,
 * description }, fn)`. Returns a handle to pass to `ctx.run`.
 */
export function task(name, optionsOrFn, maybeFn) {
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const opts = typeof optionsOrFn === 'function' || optionsOrFn == null ? {} : optionsOrFn;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TypeError(`invalid task name ${JSON.stringify(name)}: use letters, digits, ".", "_" or "-" (max 64)`);
  if (typeof fn !== 'function') throw new TypeError(`task "${name}" needs a function`);
  if (registry.has(name)) throw new Error(`task "${name}" is registered twice`);
  if (typeof opts !== 'object') throw new TypeError(`options of task "${name}" must be an object`);
  const options = {
    retries: Math.floor(number('retries', opts.retries, 0, 20)),
    timeoutSeconds: number('timeoutSeconds', opts.timeoutSeconds, 1, 86_400),
    backoffSeconds: number('backoffSeconds', opts.backoffSeconds, 0, 3600),
    maxBackoffSeconds: number('maxBackoffSeconds', opts.maxBackoffSeconds, 0, 86_400),
    description: typeof opts.description === 'string' ? opts.description.slice(0, 500) : null,
  };
  registry.set(name, { name, fn, options });
  // Under NAV, start once the entry module (and everything it imports) has finished registering tasks.
  if (process.env.NAV_WORKFLOW_MODE && !autoStart && !started) autoStart = setTimeout(() => void start(), 0);
  return Object.freeze({ name, options: Object.freeze({ ...options }) });
}

/** The registered tasks and their options (what `describe` mode reports). */
export function describe() {
  return {
    status: 'described',
    sdk: { language: 'javascript', version: SDK_VERSION },
    tasks: [...registry.values()].map((t) => ({ name: t.name, ...t.options })),
  };
}

// --- Execution -----------------------------------------------------------------------------------------

/** JSON round-trip: what the task returns or passes on is exactly what NAV stores. */
function toJson(value, what) {
  if (value === undefined) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new NonRetryableError(`${what} is not JSON-serializable: ${err.message}`);
  }
  return text === undefined ? null : JSON.parse(text);
}

function serializeError(err) {
  if (err instanceof Error) return { name: err.name, message: err.message || String(err), stack: err.stack ? String(err.stack).slice(0, 8000) : null };
  return { name: 'Error', message: typeof err === 'string' ? err : JSON.stringify(err) ?? String(err), stack: null };
}

const retryable = (err) => !(err && typeof err === 'object' && err.retryable === false);
const pending = () => new Promise(() => {});

/**
 * Executes one invocation of a task: `{ task, input, runId?, attempt?, steps? }` where `steps` are the recorded
 * results of earlier ctx.run / ctx.sleep calls. Resolves with the result NAV stores:
 *   { status: 'succeeded', output } | { status: 'failed', error, retryable } | { status: 'suspended', steps }
 */
export async function execute(invocation) {
  const def = registry.get(invocation.task);
  if (!def) return { status: 'failed', error: { name: 'Error', message: `task "${invocation.task}" is not registered in this build`, stack: null }, retryable: false };
  const journal = new Map((invocation.steps ?? []).map((s) => [s.seq, s]));
  const requests = [];
  let seq = 0;
  let wake;
  const suspended = new Promise((resolve) => { wake = resolve; });
  let scheduled = false;
  // Let every step requested in the same tick (Promise.all fan-out) register before suspending.
  const suspend = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => setImmediate(wake));
  };
  // Divergence fails the run even if the task catches the error: the recorded history no longer applies.
  let diverged = null;
  const mismatch = (s, what, step) => {
    diverged ??= new NonDeterminismError(`step ${s} is ${what} now but was ${step.kind === 'run' ? `run("${step.task}")` : 'sleep()'} on an earlier execution; code outside ctx.run and ctx.sleep must be deterministic`);
    return Promise.reject(diverged);
  };

  const ctx = Object.freeze({
    runId: invocation.runId ?? null,
    task: def.name,
    attempt: invocation.attempt ?? 1,
    run(target, input) {
      const name = typeof target === 'string' ? target : target?.name;
      if (typeof name !== 'string') return Promise.reject(new TypeError('ctx.run expects a task handle or a task name'));
      const s = ++seq;
      const step = journal.get(s);
      if (step) {
        if (step.kind !== 'run' || step.task !== name) return mismatch(s, `run("${name}")`, step);
        if (step.status === 'succeeded') return Promise.resolve(toJson(step.output, 'output'));
        if (step.status === 'failed' || step.status === 'canceled') return Promise.reject(new TaskRunError(step));
        suspend();
        return pending();
      }
      let value;
      try {
        value = toJson(input, `input of subtask "${name}"`);
      } catch (err) {
        return Promise.reject(err);
      }
      requests.push({ seq: s, kind: 'run', task: name, input: value });
      suspend();
      return pending();
    },
    sleep(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return Promise.reject(new TypeError('ctx.sleep expects a duration in milliseconds'));
      const s = ++seq;
      const step = journal.get(s);
      if (step) {
        if (step.kind !== 'sleep') return mismatch(s, 'sleep()', step);
        if (step.status === 'succeeded') return Promise.resolve();
        suspend();
        return pending();
      }
      requests.push({ seq: s, kind: 'sleep', ms: Math.round(ms) });
      suspend();
      return pending();
    },
  });

  const outcome = await Promise.race([
    (async () => def.fn(toJson(invocation.input, 'input'), ctx))().then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    suspended.then(() => null),
  ]);
  if (diverged) return { status: 'failed', error: serializeError(diverged), retryable: false };
  // Steps started but not awaited before returning still get recorded and run.
  if (outcome === null || (outcome.ok && requests.length)) return { status: 'suspended', steps: requests };
  if (!outcome.ok) return { status: 'failed', error: serializeError(outcome.error), retryable: retryable(outcome.error) };
  try {
    return { status: 'succeeded', output: toJson(outcome.value, 'the task result') };
  } catch (err) {
    return { status: 'failed', error: serializeError(err), retryable: false };
  }
}

/** Encodes a result as the marker lines the NAV agent reads from stdout. */
export function encodeResult(result) {
  const data = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0, n = 0; i < data.length || n === 0; i += CHUNK, n++) lines.push(`${MARK}${n}:${data.slice(i, i + CHUNK)}`);
  lines.push(`${END}${lines.length}`);
  return `\n${lines.join('\n')}\n`;
}

function readInvocation() {
  const file = process.env.NAV_WORKFLOW_INVOCATION_FILE || path.join(process.env.NAV_SECRETS_DIR || '/etc/secrets', INVOCATION_FILE);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Runs the mode NAV asked for and exits. Called automatically after the entry module loads when NAV starts the
 * service; call it yourself only if tasks are registered asynchronously (after a top-level await).
 */
export async function start() {
  if (started) return;
  started = true;
  if (autoStart) clearTimeout(autoStart);
  const mode = process.env.NAV_WORKFLOW_MODE;
  if (!mode) {
    console.error('[nav-workflows] NAV_WORKFLOW_MODE is not set; nothing to run (NAV sets it when it describes or runs tasks)');
    return;
  }
  let result;
  try {
    if (mode === 'describe') result = describe();
    else if (mode === 'run') result = await execute(readInvocation());
    else result = { status: 'failed', error: { name: 'Error', message: `unknown NAV_WORKFLOW_MODE "${mode}"`, stack: null }, retryable: false };
  } catch (err) {
    result = { status: 'failed', error: serializeError(err), retryable: true };
  }
  await new Promise((resolve) => process.stdout.write(encodeResult(result), () => resolve()));
  process.exit(0);
}

// --- Client: start and inspect runs from any service --------------------------------------------------

const TERMINAL = ['succeeded', 'failed', 'canceled'];

/**
 * API client for starting runs. Inside NAV services, NAV_API_URL and NAV_WORKFLOWS_TOKEN are injected (the token
 * may start and read runs of workflows in the same workspace); elsewhere pass an API key.
 */
export function createClient(opts = {}) {
  const apiUrl = (opts.apiUrl ?? process.env.NAV_API_URL ?? '').replace(/\/+$/, '');
  const token = opts.token ?? process.env.NAV_WORKFLOWS_TOKEN ?? process.env.NAV_API_KEY;
  const call = async (method, p, body, headers = {}) => {
    if (!apiUrl) throw new Error('NAV_API_URL is not set; pass { apiUrl } to createClient');
    if (!token) throw new Error('no token: set NAV_WORKFLOWS_TOKEN or NAV_API_KEY, or pass { token } to createClient');
    const res = await fetch(`${apiUrl}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`NAV API ${method} ${p} failed (${res.status}): ${data?.error?.message ?? text.slice(0, 200)}`);
    return data;
  };
  const enc = encodeURIComponent;
  const client = {
    /** Starts a run of `task` in `workflow` (a workflow service id or slug). */
    runTask(workflow, taskName, input, { idempotencyKey } = {}) {
      return call('POST', `/workflows/${enc(workflow)}/tasks/${enc(taskName)}/runs`, { input: input ?? null, ...(idempotencyKey ? { idempotencyKey } : {}) });
    },
    getRun(runId) {
      return call('GET', `/workflow-runs/${enc(runId)}`).then((r) => r.run);
    },
    cancelRun(runId) {
      return call('POST', `/workflow-runs/${enc(runId)}/cancel`, {});
    },
    /** Polls until the run finishes; resolves with the final run. */
    async waitForRun(runId, { timeoutMs = 10 * 60_000, intervalMs = 1000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = await client.getRun(runId);
        if (TERMINAL.includes(run.status)) return run;
        if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
  return client;
}

/** Shorthand for `createClient().runTask(...)` using the injected environment. */
export function runTask(workflow, taskName, input, options) {
  return createClient().runTask(workflow, taskName, input, options);
}
