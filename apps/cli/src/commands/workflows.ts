import { readFile } from 'node:fs/promises';
import type { LogLine, Page, Workflow, WorkflowRun, WorkflowRunDetail } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { matchByRef, workspaceContext, type WorkspaceContext } from '../context.ts';
import { CliError, UsageError } from '../errors.ts';
import { sleep, trapInterrupt } from '../signal.ts';
import { RUN_TERMINAL } from '../status.ts';
import {
  dim, durationBetween, err, green, kv, out, printJson, red, relativeTime, statusText, table, truncate,
} from '../output.ts';
import { formatLogLine } from './logs.ts';

const LIST_USAGE = 'nav workflows [list] [--json]';
const TASKS_USAGE = 'nav workflows tasks <workflow> [--json]';
const RUN_USAGE = "nav workflows run <workflow> <task> [--input '<json>' | --input-file <path>] [--idempotency-key <key>] [--wait] [--json]";
const RUNS_USAGE = 'nav workflows runs <workflow> [--status <s,...>] [--task <name>] [--all] [--limit <n>] [--json]';
const GET_USAGE = 'nav workflows get <run-id> [--json]';
const LOGS_USAGE = 'nav workflows logs <run-id> [--json]';
const CANCEL_USAGE = 'nav workflows cancel <run-id> [--json]';
const RETRY_USAGE = 'nav workflows retry <run-id> [--wait] [--json]';

async function findWorkflow(ctx: WorkspaceContext, ref: string): Promise<Workflow> {
  const { items } = await ctx.client.get<Page<Workflow>>(`/workspaces/${ctx.workspaceId}/workflows`);
  const named = items.map((w) => ({ id: w.service.id, name: w.service.name, slug: w.service.slug, workflow: w }));
  return matchByRef(named, ref, 'workflow', 'run nav workflows to list the workflows in this workspace').workflow;
}

const json = (value: unknown): string => (value === undefined ? '' : JSON.stringify(value));

async function listWorkflows(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  args.maxPositionals(0, LIST_USAGE);
  const ctx = await workspaceContext();
  const { items } = await ctx.client.get<Page<Workflow>>(`/workspaces/${ctx.workspaceId}/workflows`);
  if (args.bool('json')) return printJson(items);
  if (!items.length) return out('No workflows yet. Create one with: nav services create --type workflow --name <name> --repo <url>');
  out(table(
    ['id', 'name', 'status', 'tasks', 'running', 'waiting', 'queued', 'failed'],
    items.map((w) => [w.service.id, w.service.name, statusText(w.service.status), String(w.tasks.length), String(w.counts.running), String(w.counts.waiting), String(w.counts.queued), String(w.counts.failed)]),
  ));
}

async function listTasks(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const wf = await findWorkflow(await workspaceContext(), args.arg(0, 'workflow', TASKS_USAGE));
  args.maxPositionals(1, TASKS_USAGE);
  if (args.bool('json')) return printJson(wf.tasks);
  if (!wf.tasks.length) return out(`${wf.service.name} has no tasks yet: deploy it so NAV can discover them.`);
  out(table(
    ['task', 'retries', 'timeout', 'backoff', 'description'],
    wf.tasks.map((t) => [t.name, String(t.retries), `${t.timeoutSeconds}s`, `${t.backoffSeconds}s (max ${t.maxBackoffSeconds}s)`, truncate(t.description ?? '', 48)]),
  ));
}

function runRow(r: WorkflowRun): string[] {
  return [r.id, r.task, statusText(r.status), `${r.attempts}/${r.maxAttempts}`, r.trigger, relativeTime(r.createdAt), durationBetween(r.startedAt, r.finishedAt), truncate(r.error ?? '', 40)];
}

async function listRuns(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { status: { type: 'string' }, task: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' } });
  const ctx = await workspaceContext();
  const wf = await findWorkflow(ctx, args.arg(0, 'workflow', RUNS_USAGE));
  args.maxPositionals(1, RUNS_USAGE);
  const page = await ctx.client.get<Page<WorkflowRun>>(`/workflows/${wf.service.id}/runs`, {
    status: args.str('status'), task: args.str('task'), scope: args.bool('all') ? 'all' : undefined, limit: args.int('limit'),
  });
  if (args.bool('json')) return printJson(page.items);
  if (!page.items.length) return out(`No runs of ${wf.service.name} match.`);
  out(table(['id', 'task', 'status', 'attempts', 'trigger', 'created', 'duration', 'error'], page.items.map(runRow)));
}

function printRun(d: WorkflowRunDetail): void {
  const r = d.run;
  out(kv([
    ['Run', r.id],
    ['Task', r.task],
    ['Status', statusText(r.status)],
    ['Attempts', `${r.attempts}/${r.maxAttempts}`],
    ['Trigger', r.trigger],
    ['Parent', r.parentRunId],
    ['Created', relativeTime(r.createdAt)],
    ['Duration', durationBetween(r.startedAt, r.finishedAt)],
    ['Input', truncate(json(r.input), 200)],
    ['Output', r.status === 'succeeded' ? truncate(json(r.output), 200) : null],
    ['Error', r.error],
  ]));
  const children = d.tree.filter((c) => c.parentRunId === r.id);
  if (children.length) {
    out('');
    out(table(['subtask run', 'task', 'status', 'attempts', 'trigger', 'created', 'duration', 'error'], children.map(runRow)));
  }
}

async function getRun(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const id = args.arg(0, 'run id', GET_USAGE);
  args.maxPositionals(1, GET_USAGE);
  const ctx = await workspaceContext();
  const d = await ctx.client.get<WorkflowRunDetail>(`/workflow-runs/${encodeURIComponent(id)}`);
  if (args.bool('json')) return printJson(d);
  printRun(d);
}

async function runLogs(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const id = args.arg(0, 'run id', LOGS_USAGE);
  args.maxPositionals(1, LOGS_USAGE);
  const ctx = await workspaceContext();
  const { items } = await ctx.client.get<{ items: LogLine[] }>(`/workflow-runs/${encodeURIComponent(id)}/logs`);
  if (args.bool('json')) return printJson(items);
  for (const line of items) out(formatLogLine(line));
}

// Polls until the run finishes, printing new log lines as they arrive. Returns null when interrupted.
async function waitForRun(ctx: WorkspaceContext, run: WorkflowRun, quiet: boolean): Promise<WorkflowRunDetail | null> {
  const interrupt = trapInterrupt();
  let lastId = 0;
  const print = quiet ? err : out;
  try {
    for (;;) {
      const logs = await ctx.client.get<{ items: LogLine[] }>(`/workflow-runs/${run.id}/logs`, { after: lastId });
      for (const line of logs.items) {
        lastId = Math.max(lastId, line.id);
        print(formatLogLine(line));
      }
      const d = await ctx.client.get<WorkflowRunDetail>(`/workflow-runs/${run.id}`);
      if (RUN_TERMINAL.includes(d.run.status)) {
        const rest = await ctx.client.get<{ items: LogLine[] }>(`/workflow-runs/${run.id}/logs`, { after: lastId });
        for (const line of rest.items) print(formatLogLine(line));
        return d;
      }
      await sleep(1000, interrupt.signal);
      if (interrupt.signal.aborted) return null;
    }
  } finally {
    interrupt.dispose();
  }
}

async function finish(ctx: WorkspaceContext, run: WorkflowRun, wait: boolean, asJson: boolean, verb: string): Promise<void> {
  if (!wait) {
    if (asJson) printJson(run);
    else out(`${green(verb)} run ${run.id} of ${run.task} (${run.status})`);
    return;
  }
  if (!asJson) out(dim(`Run ${run.id} ${run.status}; following its logs`));
  const done = await waitForRun(ctx, run, asJson);
  if (!done) {
    err(dim(`Interrupted. Run ${run.id} keeps going on the server.`));
    process.exitCode = 130;
    return;
  }
  if (asJson) printJson(done);
  else {
    const line = `Run ${done.run.id} ${done.run.status}${done.run.status === 'succeeded' ? `: ${truncate(json(done.run.output), 400)}` : done.run.error ? `: ${done.run.error}` : ''}`;
    out(done.run.status === 'succeeded' ? green(line) : red(line));
  }
  process.exitCode = done.run.status === 'succeeded' ? 0 : 1;
}

async function startRun(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { input: { type: 'string' }, 'input-file': { type: 'string' }, 'idempotency-key': { type: 'string' }, wait: { type: 'boolean' } });
  const ref = args.arg(0, 'workflow', RUN_USAGE);
  const taskName = args.arg(1, 'task', RUN_USAGE);
  args.maxPositionals(2, RUN_USAGE);
  if (args.str('input') !== undefined && args.str('input-file') !== undefined) throw new UsageError('use either --input or --input-file');
  const raw = args.str('input-file') !== undefined ? await readFile(args.str('input-file')!, 'utf8') : args.str('input');
  let input: unknown = null;
  if (raw !== undefined) {
    try {
      input = JSON.parse(raw);
    } catch (error) {
      throw new UsageError(`--input is not valid JSON: ${(error as Error).message}`);
    }
  }
  const ctx = await workspaceContext();
  const wf = await findWorkflow(ctx, ref);
  if (wf.tasks.length && !wf.tasks.some((t) => t.name === taskName)) {
    throw new CliError(`${wf.service.name} has no task "${taskName}"`, `tasks: ${wf.tasks.map((t) => t.name).join(', ')}`);
  }
  const key = args.str('idempotency-key');
  const run = await ctx.client.post<WorkflowRun>(`/workflows/${wf.service.id}/tasks/${encodeURIComponent(taskName)}/runs`, { input, trigger: 'cli', ...(key ? { idempotencyKey: key } : {}) });
  await finish(ctx, run, args.bool('wait'), args.bool('json'), 'Started');
}

async function cancelRun(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const id = args.arg(0, 'run id', CANCEL_USAGE);
  args.maxPositionals(1, CANCEL_USAGE);
  const ctx = await workspaceContext();
  const run = await ctx.client.post<WorkflowRun>(`/workflow-runs/${encodeURIComponent(id)}/cancel`);
  if (args.bool('json')) return printJson(run);
  out(`Run ${run.id} is ${statusText(run.status)}`);
}

async function retryRun(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { wait: { type: 'boolean' } });
  const id = args.arg(0, 'run id', RETRY_USAGE);
  args.maxPositionals(1, RETRY_USAGE);
  const ctx = await workspaceContext();
  const run = await ctx.client.post<WorkflowRun>(`/workflow-runs/${encodeURIComponent(id)}/retry`);
  await finish(ctx, run, args.bool('wait'), args.bool('json'), 'Retried as');
}

async function workflowsCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return listWorkflows(rest);
    case 'tasks': return listTasks(rest);
    case 'run': return startRun(rest);
    case 'runs': return listRuns(rest);
    case 'get': return getRun(rest);
    case 'logs': return runLogs(rest);
    case 'cancel': return cancelRun(rest);
    case 'retry': return retryRun(rest);
    default:
      if (sub.startsWith('-')) return listWorkflows(argv);
      throw new UsageError(`unknown workflows subcommand "${sub}"`, 'run nav help workflows to see the subcommands');
  }
}

export const workflowCommands: CommandDef[] = [
  {
    name: 'workflows',
    summary: 'Run and inspect durable workflow tasks',
    usage: [
      LIST_USAGE, TASKS_USAGE, RUN_USAGE, RUNS_USAGE, GET_USAGE, LOGS_USAGE, CANCEL_USAGE, RETRY_USAGE,
      `Example: nav workflows run jobs send-email --input '{"to":"ada@example.com"}' --wait`,
    ],
    run: workflowsCommand,
  },
];
