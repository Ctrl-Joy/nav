// End to end: NAV Workflows through the real API and agent code paths, with the process driver, a private
// PostgreSQL cluster and a private Git server in a temp dir. Builds examples/workflows (with the vendored SDK),
// discovers its tasks, then runs tasks covering retries, a non-retryable failure, a timeout, fan-out with a durable
// sleep, idempotency keys, cancellation and service tokens.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PG_PORT = Number(process.env.NAV_TEST_PG_PORT ?? (await freePort()));
const PASSWORD = 'navtest';
const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-wf-test-'));
process.env.NAV_DATABASE_URL = `postgres://nav:${PASSWORD}@127.0.0.1:${PG_PORT}/postgres`;
process.env.NAV_MASTER_KEY ??= 'b'.repeat(64);
process.env.NAV_DATA_DIR = path.join(dir, 'nav');
process.env.NAV_DRIVER = 'process';
process.env.NAV_ARTIFACT_UPLOAD = 'never';

const cluster = await import('../src/lib/pgcluster.ts');
const spec = { dataDir: path.join(dir, 'pg'), port: PG_PORT, superuser: 'nav', password: PASSWORD, listen: '127.0.0.1' };

let app: FastifyInstance;
let db: typeof import('../src/db/pool.ts');
let gitServer: Server;
let gitPort = 0;
let stopAgent: () => Promise<void> = async () => {};

/** A minimal agent: claims deploy and workflow jobs with the real queue code and runs the real handlers. */
async function startAgent(): Promise<() => Promise<void>> {
  const { processDriver } = await import('../src/agent/runtime/process.ts');
  const { InstanceManager } = await import('../src/agent/instances.ts');
  const { handleDeploy } = await import('../src/agent/handlers.ts');
  const { handleWorkflowRun } = await import('../src/agent/workflows.ts');
  const { claim } = await import('../src/agent/queue.ts');
  const driver = processDriver();
  const nodeId = 'node_test';
  const ctx = { driver, instances: new InstanceManager(driver, nodeId), nodeId };
  const handlers: Record<string, (c: typeof ctx, p: any) => Promise<void>> = { deploy: handleDeploy, workflow_run: handleWorkflowRun };
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  const runJob = async (job: { id: number; kind: string; payload: any }) => {
    try {
      await handlers[job.kind]?.(ctx, job.payload);
      await db.q("UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1", [job.id]);
    } catch (err) {
      console.error(`[test agent] ${job.kind} failed`, err);
      await db.q("UPDATE jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [job.id, (err as Error).message]);
    }
  };
  const loop = (async () => {
    while (!stopped) {
      for (const lane of ['work', 'workflow'] as const) {
        while (!stopped && inflight.size < 8) {
          const job = await claim(nodeId, lane, false);
          if (!job) break;
          const p: Promise<void> = runJob(job).finally(() => inflight.delete(p));
          inflight.add(p);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    await Promise.allSettled([...inflight]);
  };
}

before(async () => {
  await cluster.initCluster(spec);
  await cluster.startCluster(spec);
  db = await import('../src/db/pool.ts');
  await (await import('../src/db/migrate.ts')).migrate();
  app = await (await import('../src/http/app.ts')).buildApp();
  // Publish examples/workflows (with the vendored SDK) to a private Git server.
  const gs = await import('../../../scripts/git-serve.ts');
  const repos = path.join(dir, 'git');
  await gs.publish('workflows', path.join(repoRoot, 'examples', 'workflows'), 'Example workflow', repos);
  gitPort = await freePort();
  gitServer = gs.createGitServer(repos);
  await new Promise<void>((r) => gitServer.listen(gitPort, '127.0.0.1', () => r()));
  stopAgent = await startAgent();
});

after(async () => {
  await stopAgent();
  await app?.close();
  gitServer?.close();
  await db?.pool.end();
  await cluster.stopCluster(spec.dataDir, 'immediate').catch(() => {});
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

type Res = { status: number; body: any };

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.cookie && method !== 'GET') headers['x-nav-csrf'] = '1';
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await app.inject({ method: method as 'GET', url, headers, payload });
  let body: any = res.body;
  try { body = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.statusCode, body };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let cookie = '';
let workspaceId = '';
let workflowId = '';

const detail = async (runId: string) => (await call('GET', `/api/v1/workflow-runs/${runId}`, { cookie })).body;
const finished = (runId: string, timeoutMs?: number) =>
  until(`run ${runId} to finish`, async () => {
    const d = await detail(runId);
    return ['succeeded', 'failed', 'canceled'].includes(d.run.status) ? d : null;
  }, timeoutMs);
const start = async (task: string, input: unknown, extra: Record<string, unknown> = {}) => {
  const r = await call('POST', `/api/v1/workflows/${workflowId}/tasks/${task}/runs`, { cookie, body: { input, ...extra } });
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
  return r.body;
};

test('a workflow service builds and its tasks are discovered at deploy time', { timeout: 6 * 60_000 }, async () => {
  const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'wf@example.test', password: 'correct horse battery' }) });
  assert.equal(signup.statusCode, 201, signup.body);
  cookie = `nav_session=${signup.cookies.find((c) => c.name === 'nav_session')!.value}`;
  workspaceId = (await call('GET', '/api/v1/auth/me', { cookie })).body.workspaces[0].id;

  const created = await call('POST', `/api/v1/workspaces/${workspaceId}/services`, {
    cookie,
    body: { name: 'jobs', type: 'workflow', repoUrl: `http://127.0.0.1:${gitPort}/workflows.git`, branch: 'main' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  workflowId = created.body.service.id;
  const deployId = created.body.deploy.id;

  const deploy = await until('the deploy to finish', async () => {
    const d = (await call('GET', `/api/v1/deploys/${deployId}`, { cookie })).body;
    return ['live', 'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled'].includes(d.status) ? d : null;
  }, 5 * 60_000);
  if (deploy.status !== 'live') {
    const logs = (await call('GET', `/api/v1/deploys/${deployId}/logs`, { cookie })).body.items.map((l: any) => l.message).join('\n');
    assert.fail(`deploy ${deploy.status}: ${deploy.error}\n${logs}`);
  }

  const wf = (await call('GET', `/api/v1/workflows/${workflowId}`, { cookie })).body;
  assert.deepEqual(wf.tasks.map((t: any) => t.name).sort(), ['flaky', 'send-email', 'slow-report', 'square', 'sum-of-squares', 'validate-signup', 'welcome']);
  const flaky = wf.tasks.find((t: any) => t.name === 'flaky');
  assert.equal(flaky.retries, 3);
  assert.equal(flaky.backoffSeconds, 0.5);
  assert.equal(wf.maxConcurrency, 10);
  // The slug works as a reference too.
  assert.equal((await call('GET', `/api/v1/workflows/${wf.service.slug}`, { cookie })).status, 200);
  assert.equal((await call('POST', `/api/v1/workflows/${workflowId}/tasks/nope/runs`, { cookie, body: {} })).status, 404);
});

test('runs: retries with backoff, non-retryable failure, timeout and fan-out with a durable sleep', { timeout: 4 * 60_000 }, async () => {
  assert.ok(workflowId, 'the workflow deployed');
  const [flaky, invalid, slow, fan, welcome] = await Promise.all([
    start('flaky', { failTimes: 2 }),
    start('validate-signup', { email: 'nope' }),
    start('slow-report', { seconds: 30 }),
    start('sum-of-squares', { numbers: [2, 3, 4], pauseMs: 500 }),
    start('welcome', { email: 'not-an-email' }),
  ]);
  assert.equal(flaky.status, 'queued');
  assert.equal(flaky.maxAttempts, 4);

  // Retries: two failed attempts, then success on the third.
  const f = await finished(flaky.id);
  assert.equal(f.run.status, 'succeeded', f.run.error);
  assert.deepEqual(f.run.output, { succeededOnAttempt: 3 });
  assert.equal(f.run.attempts, 3);
  assert.deepEqual(f.run.executions.map((e: any) => e.outcome), ['failed', 'failed', 'succeeded']);
  const logs = (await call('GET', `/api/v1/workflow-runs/${flaky.id}/logs`, { cookie })).body.items.map((l: any) => l.message);
  assert.ok(logs.some((m: string) => m.includes('flaky: attempt 1')), logs.join('\n'));
  assert.ok(logs.some((m: string) => m.includes('Retrying in')), logs.join('\n'));
  assert.ok(!logs.some((m: string) => m.includes('::nav-workflow')), 'result markers are not shipped as logs');

  // A non-retryable error fails at once even though the task allows 5 retries.
  const v = await finished(invalid.id);
  assert.equal(v.run.status, 'failed');
  assert.equal(v.run.attempts, 1);
  assert.match(v.run.error, /NonRetryableError: invalid email "nope"/);

  // The per-task timeout stops the attempt.
  const s = await finished(slow.id);
  assert.equal(s.run.status, 'failed');
  assert.equal(s.run.error, 'timed out after 2s');
  assert.deepEqual(s.run.executions.map((e: any) => e.outcome), ['timed_out']);

  // Fan-out: three child runs, then a sleep, then the total from replayed child results.
  const p = await finished(fan.id);
  assert.equal(p.run.status, 'succeeded', p.run.error);
  assert.deepEqual(p.run.output, { squares: [4, 9, 16], total: 29 });
  const children = p.tree.filter((r: any) => r.parentRunId === fan.id);
  assert.equal(children.length, 3);
  assert.ok(children.every((c: any) => c.status === 'succeeded' && c.task === 'square' && c.trigger === 'subtask' && c.rootRunId === fan.id));
  assert.deepEqual(children.map((c: any) => c.output).sort(), [16, 4, 9].sort());
  assert.deepEqual(p.steps.map((st: any) => st.kind), ['run', 'run', 'run', 'sleep']);
  assert.deepEqual(p.run.executions.map((e: any) => [e.kind, e.outcome]), [['start', 'suspended'], ['resume', 'suspended'], ['resume', 'succeeded']]);
  assert.equal(p.run.attempts, 1, 'resuming does not use up attempts');
  // Top-level listing hides subtasks unless asked.
  const top = (await call('GET', `/api/v1/workflows/${workflowId}/runs?task=sum-of-squares`, { cookie })).body.items;
  assert.deepEqual(top.map((r: any) => r.id), [fan.id]);
  const subs = (await call('GET', `/api/v1/workflows/${workflowId}/runs?parentRunId=${fan.id}`, { cookie })).body.items;
  assert.equal(subs.length, 3);

  // A failed subtask surfaces in the parent.
  const w = await finished(welcome.id);
  assert.equal(w.run.status, 'failed');
  assert.match(w.run.error, /subtask "validate-signup" failed/);
  assert.equal(w.tree.find((r: any) => r.parentRunId === welcome.id).status, 'failed');

  const failedOnly = (await call('GET', `/api/v1/workflows/${workflowId}/runs?status=failed`, { cookie })).body.items;
  assert.deepEqual(new Set(failedOnly.map((r: any) => r.id)), new Set([invalid.id, slow.id, welcome.id]));

  // Retry creates a fresh run from the same input.
  const again = await call('POST', `/api/v1/workflow-runs/${invalid.id}/retry`, { cookie });
  assert.equal(again.status, 201);
  assert.equal(again.body.retryOf, invalid.id);
  assert.deepEqual(again.body.input, { email: 'nope' });
  assert.equal((await finished(again.body.id)).run.status, 'failed');
});

test('idempotency keys, cancellation of a waiting run, and service tokens', { timeout: 3 * 60_000 }, async () => {
  assert.ok(workflowId, 'the workflow deployed');
  const a = await call('POST', `/api/v1/workflows/${workflowId}/tasks/send-email/runs`, { cookie, body: { input: { to: 'ada@example.test' } }, headers: { 'idempotency-key': 'order-42' } });
  const b = await call('POST', `/api/v1/workflows/${workflowId}/tasks/send-email/runs`, { cookie, body: { input: { to: 'ada@example.test' }, idempotencyKey: 'order-42' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal((await call('POST', `/api/v1/workflows/${workflowId}/tasks/flaky/runs`, { cookie, body: { idempotencyKey: 'order-42' } })).status, 409);
  const mail = await finished(a.body.id);
  assert.deepEqual(mail.run.output, { delivered: true, to: 'ada@example.test' });

  // A run waiting on a long durable sleep holds no process and can be canceled.
  const long = await start('sum-of-squares', { numbers: [5], pauseMs: 10 * 60_000 });
  await until('the run to wait on its sleep', async () => {
    const d = await detail(long.id);
    return d.run.status === 'waiting' && d.steps.some((st: any) => st.kind === 'sleep') ? d : null;
  }, 90_000);
  const canceled = await call('POST', `/api/v1/workflow-runs/${long.id}/cancel`, { cookie });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.status, 'canceled');
  const counts = (await call('GET', `/api/v1/workflows/${workflowId}`, { cookie })).body.counts;
  assert.ok(counts.canceled >= 1 && counts.succeeded >= 3);

  // Services use their injected token, scoped to their workspace.
  const { workflowsToken } = await import('../src/lib/workflows.ts');
  const token = workflowsToken(workspaceId);
  const viaToken = await call('POST', `/api/v1/workflows/${workflowId}/tasks/square/runs`, { bearer: token, body: { input: 7 } });
  assert.equal(viaToken.status, 201, JSON.stringify(viaToken.body));
  assert.equal(viaToken.body.trigger, 'service');
  const sq = await until('the token run', async () => {
    const r = await call('GET', `/api/v1/workflow-runs/${viaToken.body.id}`, { bearer: token });
    return r.body.run.status === 'succeeded' ? r.body : null;
  }, 60_000);
  assert.equal(sq.run.output, 49);
  assert.equal((await call('POST', `/api/v1/workflows/${workflowId}/tasks/square/runs`, { bearer: workflowsToken('ws_other'), body: { input: 1 } })).status, 404);
  assert.equal((await call('POST', `/api/v1/workflows/${workflowId}/tasks/square/runs`, { bearer: `${token.slice(0, -2)}xx`, body: { input: 1 } })).status, 401);
  // The token cannot do anything else.
  assert.equal((await call('GET', `/api/v1/services/${workflowId}`, { bearer: token })).status, 404);
  assert.equal((await call('GET', '/api/v1/auth/me', { bearer: token })).status, 401);
  assert.equal((await call('PATCH', `/api/v1/workflows/${workflowId}`, { bearer: token, body: { maxConcurrency: 2 } })).status, 404);
});
