import type { Deploy, Service } from '@nav/shared';
import { parseCommandArgs, pick } from '../args.ts';
import { listAll } from '../api.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext } from '../context.ts';
import { parseKeyValue } from '../dotenv.ts';
import { UsageError } from '../errors.ts';
import { confirm, isInteractive } from '../prompt.ts';
import { RUNTIMES, SERVICE_TYPES } from '../status.ts';
import { bold, green, kv, out, printJson, relativeTime, statusText, table } from '../output.ts';

const LIST_USAGE = 'nav services [--type TYPE] [--json]';
const SHOW_USAGE = 'nav services show <id|name> [--json]';
const CREATE_USAGE = 'nav services create --name NAME --type TYPE [--repo URL] [--branch BRANCH] '
  + '[--runtime RUNTIME] [--build CMD] [--start CMD] [--plan PLAN] [--instances N] [--schedule CRON] '
  + '[--publish-path DIR] [--health-check PATH] [--env KEY=VAL]... [--json]';
const DELETE_USAGE = 'nav services delete <id|name> [--yes] [--json]';
const LIFECYCLE_USAGE = (action: string): string => `nav services ${action} <id|name> [--json]`;
const SCALE_USAGE = 'nav services scale <id|name> <count> [--json]';

async function listServices(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { type: { type: 'string' } });
  args.maxPositionals(0, LIST_USAGE);
  const type = args.str('type');
  if (type !== undefined) pick('--type', type, SERVICE_TYPES);
  const ctx = await workspaceContext();
  const items = await listAll<Service>(ctx.client, `/workspaces/${ctx.workspaceId}/services`, { type });
  if (args.bool('json')) {
    printJson(items);
    return;
  }
  if (items.length === 0) {
    out('No services yet. Create one with nav services create.');
    return;
  }
  out(table(
    ['name', 'id', 'type', 'status', 'plan', 'instances', 'url', 'updated'],
    items.map((s) => [
      bold(s.name),
      s.id,
      s.type,
      statusText(s.status),
      s.plan,
      String(s.instanceCount),
      s.url ?? '-',
      relativeTime(s.updatedAt),
    ]),
  ));
}

async function showService(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', SHOW_USAGE);
  args.maxPositionals(1, SHOW_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  if (args.bool('json')) {
    printJson(svc);
    return;
  }
  const suspended = svc.suspended ? ' (suspended)' : '';
  out(kv([
    ['Name', svc.name],
    ['ID', svc.id],
    ['Type', svc.type],
    ['Runtime', svc.runtime],
    ['Status', `${statusText(svc.status)}${suspended}`],
    ['URL', svc.url],
    ['Internal', svc.internalAddress],
    ['Repository', svc.repoUrl],
    ['Branch', svc.branch],
    ['Image', svc.imageUrl],
    ['Plan', svc.plan],
    ['Instances', String(svc.instanceCount)],
    ['Build command', svc.buildCommand],
    ['Start command', svc.startCommand],
    ['Pre-deploy', svc.preDeployCommand],
    ['Publish path', svc.publishPath],
    ['Health check', svc.healthCheckPath],
    ['Port', svc.port === null ? null : String(svc.port)],
    ['Schedule', svc.cronSchedule],
    ['Auto deploy', svc.autoDeploy],
    ['Current deploy', svc.currentDeployId],
    ['Created', relativeTime(svc.createdAt)],
    ['Updated', relativeTime(svc.updatedAt)],
  ]));
}

async function createService(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    name: { type: 'string' },
    type: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    runtime: { type: 'string' },
    build: { type: 'string' },
    start: { type: 'string' },
    plan: { type: 'string' },
    instances: { type: 'string' },
    schedule: { type: 'string' },
    'publish-path': { type: 'string' },
    'health-check': { type: 'string' },
    env: { type: 'string', multiple: true },
  });
  args.maxPositionals(0, CREATE_USAGE);
  const name = args.str('name');
  if (!name) throw new UsageError('--name is required', `usage: ${CREATE_USAGE}`);
  const type = args.str('type');
  if (!type) throw new UsageError('--type is required', `usage: ${CREATE_USAGE}`);
  pick('--type', type, SERVICE_TYPES);
  const runtime = args.str('runtime');
  if (runtime !== undefined) pick('--runtime', runtime, RUNTIMES);
  const instances = args.int('instances');
  if (instances !== undefined && instances < 0) throw new UsageError('--instances must be 0 or more');
  const envVars = args.strs('env').map(parseKeyValue);

  const body: Record<string, unknown> = { name, type };
  const optional: Array<[string, string | number | undefined]> = [
    ['runtime', runtime],
    ['repoUrl', args.str('repo')],
    ['branch', args.str('branch')],
    ['buildCommand', args.str('build')],
    ['startCommand', args.str('start')],
    ['plan', args.str('plan')],
    ['instanceCount', instances],
    ['cronSchedule', args.str('schedule')],
    ['publishPath', args.str('publish-path')],
    ['healthCheckPath', args.str('health-check')],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) body[key] = value;
  }
  if (envVars.length > 0) body.envVars = envVars;

  const ctx = await workspaceContext();
  const created = await ctx.client.post<{ service: Service; deploy?: Deploy | null }>(
    `/workspaces/${ctx.workspaceId}/services`,
    body,
  );
  if (args.bool('json')) {
    printJson(created);
    return;
  }
  const svc = created.service;
  out(`${green('Created')} service ${bold(svc.name)} (${svc.id})`);
  if (created.deploy) out(`Deploy ${created.deploy.id} is ${created.deploy.status}. Follow it with nav logs ${svc.name} --tail`);
  if (svc.url) out(`URL ${svc.url}`);
}

async function deleteService(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { yes: { type: 'boolean', short: 'y' } });
  const ref = args.arg(0, 'service', DELETE_USAGE);
  args.maxPositionals(1, DELETE_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  if (!args.bool('yes')) {
    if (!isInteractive()) {
      throw new UsageError('refusing to delete without confirmation', 'pass --yes to delete non-interactively');
    }
    const ok = await confirm(`Delete service ${svc.name} (${svc.id})? This stops its instances and deletes its data.`);
    if (!ok) {
      out('Aborted.');
      return;
    }
  }
  await ctx.client.del(`/services/${svc.id}`);
  if (args.bool('json')) {
    printJson({ deleted: svc.id });
    return;
  }
  out(`Deleted ${svc.name}`);
}

const PAST_TENSE: Record<'suspend' | 'resume' | 'restart', string> = {
  suspend: 'suspended',
  resume: 'resumed',
  restart: 'restarted',
};

async function lifecycle(action: 'suspend' | 'resume' | 'restart', argv: string[]): Promise<void> {
  const usage = LIFECYCLE_USAGE(action);
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', usage);
  args.maxPositionals(1, usage);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  await ctx.client.post(`/services/${svc.id}/${action}`);
  if (args.bool('json')) {
    printJson({ id: svc.id, name: svc.name, action: PAST_TENSE[action] });
    return;
  }
  out(`${green(PAST_TENSE[action])} ${svc.name}`);
}

async function scaleService(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', SCALE_USAGE);
  const countText = args.arg(1, 'instance count', SCALE_USAGE);
  args.maxPositionals(2, SCALE_USAGE);
  if (!/^\d+$/.test(countText)) throw new UsageError(`instance count must be a whole number, got "${countText}"`);
  const count = Number(countText);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  await ctx.client.post(`/services/${svc.id}/scale`, { instanceCount: count });
  if (args.bool('json')) {
    printJson({ id: svc.id, name: svc.name, instanceCount: count });
    return;
  }
  out(`Scaled ${svc.name} to ${count} instance${count === 1 ? '' : 's'}`);
}

async function services(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith('-')) return listServices(argv);
  switch (first) {
    case 'show': return showService(rest);
    case 'create': return createService(rest);
    case 'delete': return deleteService(rest);
    case 'suspend':
    case 'resume':
    case 'restart':
      return lifecycle(first, rest);
    case 'scale': return scaleService(rest);
    default:
      throw new UsageError(
        `unknown services subcommand "${first}"`,
        `to inspect that service run: nav services show ${first}`,
      );
  }
}

export const serviceCommands: CommandDef[] = [
  {
    name: 'services',
    summary: 'List, inspect, create and manage services',
    usage: [
      LIST_USAGE,
      SHOW_USAGE,
      CREATE_USAGE,
      DELETE_USAGE,
      'nav services suspend|resume|restart <id|name> [--json]',
      SCALE_USAGE,
    ],
    run: services,
  },
];
