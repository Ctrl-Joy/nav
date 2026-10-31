import type { Deploy, Page } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext, type WorkspaceContext } from '../context.ts';
import { UsageError, errorMessage } from '../errors.ts';
import { isAbortError, sleep, trapInterrupt } from '../signal.ts';
import { DEPLOY_ACTIVE, DEPLOY_SUCCEEDED } from '../status.ts';
import {
  durationBetween, err, green, dim, out, printJson, red, shortSha, statusText, table, truncate, relativeTime,
} from '../output.ts';
import { formatLogLine, parseLogLine } from './logs.ts';

const LIST_USAGE = 'nav deploys <service> [--json]';
const CANCEL_USAGE = 'nav deploys cancel <deployId> [--json]';
const DEPLOY_USAGE = 'nav deploy <service> [--clear-cache] [--commit SHA] [--wait] [--json]';
const ROLLBACK_USAGE = 'nav rollback <service> <deployId> [--json]';

async function listDeploys(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', LIST_USAGE);
  args.maxPositionals(1, LIST_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const page = await ctx.client.get<Page<Deploy>>(`/services/${svc.id}/deploys`);
  if (args.bool('json')) {
    printJson(page.items);
    return;
  }
  if (page.items.length === 0) {
    out(`No deploys for ${svc.name} yet.`);
    return;
  }
  out(table(
    ['id', 'status', 'trigger', 'commit', 'message', 'created', 'duration'],
    page.items.map((d) => [
      d.id,
      statusText(d.status),
      d.trigger,
      shortSha(d.commitSha),
      truncate(d.commitMessage ?? d.error ?? '-', 50),
      relativeTime(d.createdAt),
      durationBetween(d.startedAt, d.finishedAt),
    ]),
  ));
}

async function cancelDeploy(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const id = args.arg(0, 'deploy id', CANCEL_USAGE);
  args.maxPositionals(1, CANCEL_USAGE);
  const ctx = await workspaceContext();
  const deploy = await ctx.client.post<Deploy | undefined>(`/deploys/${id}/cancel`);
  if (args.bool('json')) {
    printJson(deploy ?? { id, status: 'canceled' });
    return;
  }
  out(`Canceled deploy ${id}${deploy ? ` (${statusText(deploy.status)})` : ''}`);
}

// Streams a deploy's build and deploy logs until the server sends "end", then waits for the
// deploy to leave its active states. Returns null when interrupted with Ctrl+C.
export async function followDeploy(ctx: WorkspaceContext, deployId: string, json: boolean): Promise<Deploy | null> {
  const interrupt = trapInterrupt();
  const logLine = json ? err : out;
  try {
    try {
      for await (const message of ctx.client.stream(`/deploys/${deployId}/logs/stream`, {}, interrupt.signal)) {
        if (message.event === 'end') break;
        const line = parseLogLine(message.data);
        if (line) logLine(formatLogLine(line));
      }
    } catch (error) {
      if (interrupt.signal.aborted || isAbortError(error)) return null;
      err(dim(`log stream stopped (${errorMessage(error)}); waiting for deploy status`));
    }
    let current = await ctx.client.get<Deploy>(`/deploys/${deployId}`);
    while (DEPLOY_ACTIVE.includes(current.status)) {
      if (interrupt.signal.aborted) return null;
      await sleep(2000, interrupt.signal);
      if (interrupt.signal.aborted) return null;
      current = await ctx.client.get<Deploy>(`/deploys/${deployId}`);
    }
    return current;
  } finally {
    interrupt.dispose();
  }
}

async function deploy(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    'clear-cache': { type: 'boolean' },
    commit: { type: 'string' },
    wait: { type: 'boolean' },
  });
  const ref = args.arg(0, 'service', DEPLOY_USAGE);
  args.maxPositionals(1, DEPLOY_USAGE);
  const commit = args.str('commit');
  if (commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new UsageError('--commit must be a 7 to 40 character hex commit SHA');
  }
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const queued = await ctx.client.post<Deploy>(`/services/${svc.id}/deploys`, {
    clearCache: args.bool('clear-cache'),
    commitSha: commit,
  });
  const json = args.bool('json');

  if (!args.bool('wait')) {
    if (json) printJson(queued);
    else out(`${green('Queued')} deploy ${queued.id} for ${svc.name}. Follow it with nav logs ${svc.name} --tail`);
    return;
  }

  if (!json) out(dim(`Deploy ${queued.id} queued; streaming logs`));
  const final = await followDeploy(ctx, queued.id, json);
  if (!final) {
    err(dim(`Interrupted. Deploy ${queued.id} keeps running; check it with nav deploys ${svc.name}`));
    process.exitCode = 130;
    return;
  }
  const succeeded = DEPLOY_SUCCEEDED.includes(final.status);
  if (json) {
    printJson(final);
  } else if (succeeded) {
    out(`${green('Deploy live')}: ${svc.name} (${final.id})`);
  } else {
    out(red(`Deploy ${final.status}: ${svc.name} (${final.id})${final.error ? ` - ${final.error}` : ''}`));
  }
  process.exitCode = succeeded ? 0 : 1;
}

async function rollback(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', ROLLBACK_USAGE);
  const deployId = args.arg(1, 'deploy id', ROLLBACK_USAGE);
  args.maxPositionals(2, ROLLBACK_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const target = await ctx.client.get<Deploy>(`/deploys/${deployId}`);
  if (target.serviceId !== svc.id) {
    throw new UsageError(`deploy ${deployId} does not belong to ${svc.name}`, `run nav deploys ${svc.name} to list its deploys`);
  }
  const created = await ctx.client.post<Deploy>(`/deploys/${deployId}/rollback`);
  if (args.bool('json')) {
    printJson(created);
    return;
  }
  out(`${green('Rolling back')} ${svc.name} to ${deployId} (${shortSha(target.commitSha)}); new deploy ${created.id}`);
}

async function deploys(argv: string[]): Promise<void> {
  if (argv[0] === 'cancel') return cancelDeploy(argv.slice(1));
  return listDeploys(argv);
}

export const deployCommands: CommandDef[] = [
  {
    name: 'deploys',
    summary: 'List a service\'s deploys, or cancel one with deploys cancel <deployId>',
    usage: [LIST_USAGE, CANCEL_USAGE],
    run: deploys,
  },
  {
    name: 'deploy',
    summary: 'Trigger a deploy for a service',
    usage: [DEPLOY_USAGE],
    run: deploy,
  },
  {
    name: 'rollback',
    summary: 'Redeploy an earlier deploy\'s artifact without rebuilding',
    usage: [ROLLBACK_USAGE],
    run: rollback,
  },
];
