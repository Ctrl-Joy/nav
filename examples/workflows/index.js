// Example NAV workflow: create a service of type "workflow" from this repository, then start runs from the
// dashboard, the CLI (`nav workflows run <workflow> send-email --input '{"to":"ada@example.com"}'`) or the API.
// The SDK dependency (vendor/nav-workflows.tgz) is packed from packages/workflows by scripts/git-serve.ts when it
// publishes this repository; in your own repo, vendor a copy the same way (or `npm pack` packages/workflows).
import { NonRetryableError, task } from '@nav/workflows';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A typical side effect: retried up to 3 times (with exponential backoff) if it throws.
export const sendEmail = task('send-email', { retries: 3, timeoutSeconds: 600, description: 'Sends one email' }, async (input) => {
  if (!input?.to) throw new NonRetryableError('input.to is required');
  console.log(`sending "${input.subject ?? 'Hello'}" to ${input.to}`);
  await wait(200);
  return { delivered: true, to: input.to };
});

// Fails on its first `failTimes` attempts, then succeeds: shows automatic retries.
export const flaky = task('flaky', { retries: 3, backoffSeconds: 0.5, timeoutSeconds: 60 }, async (input, ctx) => {
  console.log(`flaky: attempt ${ctx.attempt}`);
  if (ctx.attempt <= (input?.failTimes ?? 2)) throw new Error(`transient failure on attempt ${ctx.attempt}`);
  return { succeededOnAttempt: ctx.attempt };
});

// Bad input is not worth retrying: NonRetryableError fails the run at once.
export const validateSignup = task('validate-signup', { retries: 5 }, async (input) => {
  if (!String(input?.email ?? '').includes('@')) throw new NonRetryableError(`invalid email ${JSON.stringify(input?.email ?? null)}`);
  return { ok: true };
});

// Takes longer than its timeout allows, so the attempt is stopped.
export const slowReport = task('slow-report', { timeoutSeconds: 2 }, async (input) => {
  console.log('building report...');
  await wait((input?.seconds ?? 30) * 1000);
  return { done: true };
});

export const square = task('square', { retries: 1 }, async (n) => {
  console.log(`squaring ${n}`);
  return n * n;
});

// Fan-out: one child run per number, all in parallel; then a durable sleep, then the total. The parent does not
// hold a process while it waits: NAV resumes it with the recorded child results.
export const sumOfSquares = task('sum-of-squares', { timeoutSeconds: 120 }, async (input, ctx) => {
  const numbers = input?.numbers ?? [1, 2, 3];
  const squares = await Promise.all(numbers.map((n) => ctx.run(square, n)));
  console.log(`squares: ${squares.join(', ')}`);
  await ctx.sleep(input?.pauseMs ?? 1000);
  return { squares, total: squares.reduce((a, b) => a + b, 0) };
});

// Subtasks can be awaited one after another too; failures can be caught.
export const welcome = task('welcome', async (input, ctx) => {
  await ctx.run(validateSignup, { email: input?.email });
  const mail = await ctx.run(sendEmail, { to: input.email, subject: 'Welcome!' });
  return { welcomed: input.email, mail };
});
