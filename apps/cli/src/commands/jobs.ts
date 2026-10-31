import type { LogLine, Page, Run } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext, type WorkspaceContext } from '../context.ts';
import { UsageError, errorMessage } from '../errors.ts';
import { isAbortError, sleep, trapInterrupt } from '../signal.ts';
import { RUN_TERMINAL } from '../status.ts';
import {
  dim, durationBetween, err, green, out, printJson, red, relativeTime, statusText, table, truncate,
} from '../output.ts';
import { formatLogLine, parseLogLine } from './logs.ts';

const JOBS_USAGE = 'nav jobs <service> [--json]';
const RUN_USAGE = 'nav run <service> [--wait] -- <command...> [--json]';

// Quotes an argument for a POSIX shell, since the job runs on the server.
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function listJobs(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', JOBS_USAGE);
  args.maxPositionals(1, JOBS_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const page = await ctx.client.get<Page<Run>>(`/services/${svc.id}/runs`);
  if (args.bool('json')) {
    printJson(page.items);
    return;
  }
  if (page.items.length === 0) {
    out(`No jobs or cron runs for ${svc.name} yet.`);
    return;
  }
  out(table(
    ['id', 'kind', 'status', 'command', 'exit', 'started', 'duration'],
    page.items.map((r) => [
      r.id,
      r.kind,
      statusText(r.status),
      truncate(r.command, 48),
      r.exitCode === null ? '-' : String(r.exitCode),
      relativeTime(r.createdAt),
      durationBetween(r.startedAt, r.finishedAt),
    ]),
  ));
}

// Streams a run's logs until it reaches a terminal state, then prints whatever the stream missed.
// Returns null when interrupted.
async function followRun(ctx: WorkspaceContext, run: Run, json: boolean): Promise<Run | null> {
  const interrupt = trapInterrupt();
  const streamAbort = new AbortController();
  const logLine = json ? err : out;
  let lastId: number | undefined;
  const print = (line: LogLine): void => {
    if (lastId !== undefined && line.id <= lastId) return;
    lastId = line.id;
    logLine(formatLogLine(line));
  };
  const onInterrupt = (): void => streamAbort.abort();
  interrupt.signal.addEventListener('abort', onInterrupt, { once: true });

  const streaming = (async () => {
    try {
      const stream = ctx.client.stream(`/services/${run.serviceId}/logs/stream`, { runId: run.id }, streamAbort.signal);
      for await (const message of stream) {
        const line = parseLogLine(message.data);
        if (line) print(line);
      }
    } catch (error) {
      if (!streamAbort.signal.aborted && !isAbortError(error)) {
        err(dim(`log stream stopped (${errorMessage(error)}); waiting for the run to finish`));
      }
    }
  })();

  try {
    let current = run;
    while (!RUN_TERMINAL.includes(current.status)) {
      if (interrupt.signal.aborted) return null;
      await sleep(1000, interrupt.signal);
      if (interrupt.signal.aborted) return null;
      current = await ctx.client.get<Run>(`/runs/${run.id}`);
    }
    // Give the live stream a moment to flush, then stop it and print anything it missed.
    await sleep(500, interrupt.signal);
    streamAbort.abort();
    await streaming;
    const all = await ctx.client.get<{ items: LogLine[] }>(`/runs/${run.id}/logs`);
    for (const line of all.items) print(line);
    return current;
  } finally {
    streamAbort.abort();
    interrupt.signal.removeEventListener('abort', onInterrupt);
    interrupt.dispose();
  }
}

async function runJob(argv: string[]): Promise<void> {
  // Everything after "--" is the command, so its own flags are not parsed.
  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator + 1);
  const args = parseCommandArgs(head, { wait: { type: 'boolean' } });
  const ref = args.arg(0, 'service', RUN_USAGE);
  const parts = [...args.positionals.slice(1), ...tail];
  if (parts.length === 0) throw new UsageError('no command given', `usage: ${RUN_USAGE}`);
  const command = parts.map(shellQuote).join(' ');

  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const run = await ctx.client.post<Run>(`/services/${svc.id}/runs`, { command });
  const json = args.bool('json');

  if (!args.bool('wait')) {
    if (json) printJson(run);
    else out(`${green('Started')} job ${run.id} on ${svc.name}: ${command}`);
    return;
  }

  if (!json) out(dim(`Job ${run.id} started; streaming logs`));
  const finished = await followRun(ctx, run, json);
  if (!finished) {
    err(dim(`Interrupted. Job ${run.id} may still be running.`));
    process.exitCode = 130;
    return;
  }
  const succeeded = finished.status === 'succeeded';
  if (json) {
    printJson(finished);
  } else {
    const exit = finished.exitCode === null ? '' : ` (exit ${finished.exitCode})`;
    const line = `Job ${finished.id} ${finished.status}${exit}`;
    out(succeeded ? green(line) : red(line));
  }
  process.exitCode = succeeded ? 0 : (finished.exitCode || 1);
}

export const jobCommands: CommandDef[] = [
  {
    name: 'jobs',
    summary: 'List one-off jobs and cron runs for a service',
    usage: [JOBS_USAGE],
    run: listJobs,
  },
  {
    name: 'run',
    summary: 'Run a one-off command in a service\'s environment',
    usage: [RUN_USAGE, 'Example: nav run api --wait -- node scripts/migrate.js'],
    run: runJob,
  },
];
