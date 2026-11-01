// Unit tests for the NAV Workflows SDK: registration, replay semantics and the stdout result protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { NonRetryableError, TaskRunError, describe, encodeResult, execute, task } from '../index.js';

const sdkUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js')).href;

/** Mirrors the agent's decoder (apps/control/src/agent/workflows.ts). */
function decode(stdout) {
  const chunks = [];
  let end = false;
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^::nav-workflow:(\d+):(.*)$/.exec(line);
    if (m) chunks[Number(m[1])] = m[2];
    else if (/^::nav-workflow-end::\d+$/.test(line)) end = true;
  }
  return end ? JSON.parse(Buffer.from(chunks.join(''), 'base64').toString('utf8')) : null;
}

test('task() validates names and options and describe() lists them', () => {
  const t = task('describe-me', { retries: 2, timeoutSeconds: 30, description: 'hello' }, async () => 1);
  assert.equal(t.name, 'describe-me');
  assert.deepEqual(t.options, { retries: 2, timeoutSeconds: 30, backoffSeconds: 5, maxBackoffSeconds: 600, description: 'hello' });
  assert.throws(() => task('describe-me', async () => 1), /registered twice/);
  assert.throws(() => task('bad name!', async () => 1), /invalid task name/);
  assert.throws(() => task('neg-retries', { retries: -1 }, async () => 1), /retries/);
  assert.throws(() => task('no-fn', {}), /needs a function/);
  const d = describe();
  assert.equal(d.status, 'described');
  assert.ok(d.tasks.some((x) => x.name === 'describe-me' && x.retries === 2 && x.timeoutSeconds === 30));
});

test('execute() reports success, retryable and non-retryable failures', async () => {
  task('ok', async (input) => ({ doubled: input.n * 2 }));
  task('boom', async () => { throw new Error('kaput'); });
  task('fatal', async () => { throw new NonRetryableError('bad input'); });
  task('undefined-result', async () => undefined);
  assert.deepEqual(await execute({ task: 'ok', input: { n: 21 } }), { status: 'succeeded', output: { doubled: 42 } });
  const boom = await execute({ task: 'boom', input: null });
  assert.equal(boom.status, 'failed');
  assert.equal(boom.error.message, 'kaput');
  assert.equal(boom.retryable, true);
  const fatal = await execute({ task: 'fatal' });
  assert.equal(fatal.retryable, false);
  assert.equal(fatal.error.name, 'NonRetryableError');
  assert.deepEqual(await execute({ task: 'undefined-result' }), { status: 'succeeded', output: null });
  const unknown = await execute({ task: 'nope' });
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.retryable, false);
});

test('fan-out suspends with every subtask requested in the same tick, then replays recorded results', async () => {
  const child = task('child', async (n) => n + 1);
  task('fan', async (input, ctx) => {
    const outs = await Promise.all(input.items.map((n) => ctx.run(child, n)));
    return outs.reduce((a, b) => a + b, 0);
  });
  const first = await execute({ task: 'fan', input: { items: [1, 2, 3] } });
  assert.equal(first.status, 'suspended');
  assert.deepEqual(first.steps, [
    { seq: 1, kind: 'run', task: 'child', input: 1 },
    { seq: 2, kind: 'run', task: 'child', input: 2 },
    { seq: 3, kind: 'run', task: 'child', input: 3 },
  ]);
  const steps = [2, 3, 4].map((output, i) => ({ seq: i + 1, kind: 'run', task: 'child', status: 'succeeded', output }));
  assert.deepEqual(await execute({ task: 'fan', input: { items: [1, 2, 3] }, steps }), { status: 'succeeded', output: 9 });
});

test('sequential steps suspend one at a time; sleeps are durable steps too', async () => {
  task('seq-a', async () => 'a');
  task('seq', async (_input, ctx) => {
    const a = await ctx.run('seq-a');
    await ctx.sleep(1500);
    const b = await ctx.run('seq-a', { again: true });
    return `${a}${b}`;
  });
  const r1 = await execute({ task: 'seq' });
  assert.deepEqual(r1, { status: 'suspended', steps: [{ seq: 1, kind: 'run', task: 'seq-a', input: null }] });
  const s1 = { seq: 1, kind: 'run', task: 'seq-a', status: 'succeeded', output: 'a' };
  const r2 = await execute({ task: 'seq', steps: [s1] });
  assert.deepEqual(r2, { status: 'suspended', steps: [{ seq: 2, kind: 'sleep', ms: 1500 }] });
  // Not yet due: suspends again without new requests.
  const r3 = await execute({ task: 'seq', steps: [s1, { seq: 2, kind: 'sleep', status: 'pending' }] });
  assert.deepEqual(r3, { status: 'suspended', steps: [] });
  const r4 = await execute({ task: 'seq', steps: [s1, { seq: 2, kind: 'sleep', status: 'succeeded' }] });
  assert.deepEqual(r4, { status: 'suspended', steps: [{ seq: 3, kind: 'run', task: 'seq-a', input: { again: true } }] });
  const r5 = await execute({ task: 'seq', steps: [s1, { seq: 2, kind: 'sleep', status: 'succeeded' }, { ...s1, seq: 3 }] });
  assert.deepEqual(r5, { status: 'succeeded', output: 'aa' });
});

test('a failed subtask surfaces as TaskRunError; diverging replays are detected', async () => {
  task('flaky-child', async () => 'x');
  task('catcher', async (_input, ctx) => {
    try {
      await ctx.run('flaky-child');
      return 'no error';
    } catch (err) {
      return { caught: err instanceof TaskRunError, message: err.message, runId: err.runId };
    }
  });
  const failed = { seq: 1, kind: 'run', task: 'flaky-child', runId: 'wfr_1', status: 'failed', error: { message: 'nope' } };
  assert.deepEqual(await execute({ task: 'catcher', steps: [failed] }), {
    status: 'succeeded',
    output: { caught: true, message: 'subtask "flaky-child" failed: nope', runId: 'wfr_1' },
  });
  const diverged = await execute({ task: 'catcher', steps: [{ seq: 1, kind: 'sleep', status: 'succeeded' }] });
  assert.equal(diverged.status, 'failed');
  assert.equal(diverged.error.name, 'NonDeterminismError');
  assert.equal(diverged.retryable, false);
});

test('subtasks started without await are still recorded', async () => {
  task('fire', async (_i, ctx) => {
    void ctx.run('ok', { n: 1 });
    return 'done';
  });
  const r = await execute({ task: 'fire' });
  assert.equal(r.status, 'suspended');
  assert.equal(r.steps.length, 1);
});

test('encodeResult() survives large payloads and interleaved output', () => {
  const big = { status: 'succeeded', output: 'x'.repeat(20_000) };
  const text = `hello\n${encodeResult(big)}bye\n`;
  assert.deepEqual(decode(text), big);
});

test('start() runs describe and run modes in a real process', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-wf-sdk-'));
  try {
    const entry = path.join(dir, 'main.mjs');
    await writeFile(entry, `import { task } from ${JSON.stringify(sdkUrl)};
console.log('booting');
task('greet', { retries: 1 }, async (input) => { console.log('greeting', input.name); return 'hi ' + input.name; });\n`);
    const exec = promisify(execFile);
    const described = await exec(process.execPath, [entry], { env: { ...process.env, NAV_WORKFLOW_MODE: 'describe' } });
    const d = decode(described.stdout);
    assert.equal(d.status, 'described');
    assert.deepEqual(d.tasks.map((t) => [t.name, t.retries]), [['greet', 1]]);
    assert.match(described.stdout, /booting/);

    await writeFile(path.join(dir, 'nav-workflow-invocation.json'), JSON.stringify({ task: 'greet', input: { name: 'ada' }, runId: 'wfr_x', attempt: 1, steps: [] }));
    const ran = await exec(process.execPath, [entry], { env: { ...process.env, NAV_WORKFLOW_MODE: 'run', NAV_SECRETS_DIR: dir } });
    assert.deepEqual(decode(ran.stdout), { status: 'succeeded', output: 'hi ada' });
    assert.match(ran.stdout, /greeting ada/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
