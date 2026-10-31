import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Blueprint } from '@nav/shared';
import { parseCommandArgs, requireFlag } from '../args.ts';
import { listAll } from '../api.ts';
import type { CommandDef } from '../command.ts';
import { authContext, matchByRef, workspaceContext } from '../context.ts';
import { CliError, UsageError } from '../errors.ts';
import { dim, green, out, printJson, red, statusText } from '../output.ts';

const VALIDATE_USAGE = 'nav blueprint validate [file] [--json]';
const LAUNCH_USAGE = 'nav blueprint launch --repo URL [--branch main] [--file nav.yaml] [--name NAME] [--json]';
const SYNC_USAGE = 'nav blueprint sync <id|name> [--json]';

interface PlanResponse {
  valid: boolean;
  errors?: unknown[];
  plan?: { create?: unknown[]; update?: unknown[]; unchanged?: unknown[] };
}

function describeItem(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const label = typeof obj.name === 'string' ? obj.name : typeof obj.id === 'string' ? obj.id : null;
    const type = typeof obj.type === 'string' ? obj.type : null;
    if (label) return type ? `${type} ${label}` : label;
  }
  return JSON.stringify(item);
}

function describeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return JSON.stringify(error);
}

async function validate(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const file = args.positionals[0] ?? 'nav.yaml';
  args.maxPositionals(1, VALIDATE_USAGE);
  let yaml: string;
  try {
    yaml = await readFile(resolve(file), 'utf8');
  } catch {
    throw new CliError(`cannot read ${file}`, 'pass the path to a nav.yaml file');
  }
  const { client } = await authContext();
  const result = await client.post<PlanResponse>('/blueprints/validate', { yaml });
  process.exitCode = result.valid ? 0 : 1;
  if (args.bool('json')) {
    printJson(result);
    return;
  }
  if (result.valid) {
    out(green(`${file} is valid`));
  } else {
    out(red(`${file} is invalid`));
    for (const error of result.errors ?? []) out(red(`  - ${describeError(error)}`));
  }
  const plan = result.plan;
  if (!plan) return;
  out('');
  out('Plan:');
  const groups: Array<[string, unknown[] | undefined, string]> = [
    ['create', plan.create, '+'],
    ['update', plan.update, '~'],
    ['unchanged', plan.unchanged, '='],
  ];
  for (const [label, items, mark] of groups) {
    for (const item of items ?? []) out(`  ${mark} ${label === 'unchanged' ? dim(describeItem(item)) : describeItem(item)}`);
  }
  out(dim(`${plan.create?.length ?? 0} to create, ${plan.update?.length ?? 0} to update, ${plan.unchanged?.length ?? 0} unchanged`));
}

function nameFromRepo(repo: string): string {
  const last = repo.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '') || 'blueprint';
}

async function launch(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    repo: { type: 'string' },
    branch: { type: 'string' },
    file: { type: 'string' },
    name: { type: 'string' },
  });
  args.maxPositionals(0, LAUNCH_USAGE);
  const repo = requireFlag('--repo', args.str('repo'), LAUNCH_USAGE);
  const branch = args.str('branch') ?? 'main';
  const filePath = args.str('file') ?? 'nav.yaml';
  const name = args.str('name') ?? nameFromRepo(repo);
  const ctx = await workspaceContext();
  const blueprint = await ctx.client.post<Blueprint>(`/workspaces/${ctx.workspaceId}/blueprints`, {
    name,
    repoUrl: repo,
    branch,
    filePath,
  });
  if (args.bool('json')) {
    printJson(blueprint);
    return;
  }
  out(`${green('Created')} blueprint ${blueprint.name} (${blueprint.id}), status ${statusText(blueprint.status)}`);
  out(dim(`Sync it after changes with nav blueprint sync ${blueprint.id}`));
}

async function sync(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'blueprint', SYNC_USAGE);
  args.maxPositionals(1, SYNC_USAGE);
  const ctx = await workspaceContext();
  const items = await listAll<Blueprint>(ctx.client, `/workspaces/${ctx.workspaceId}/blueprints`);
  const blueprint = matchByRef(items, ref, 'blueprint', 'run nav blueprint launch to create one');
  const result = await ctx.client.post<Blueprint | undefined>(`/blueprints/${blueprint.id}/sync`);
  if (args.bool('json')) {
    printJson(result ?? { id: blueprint.id, status: 'syncing' });
    return;
  }
  const status = result?.status ?? 'syncing';
  out(`${green('Sync started')} for ${blueprint.name}; status ${statusText(status)}`);
  if (result?.lastError) out(red(result.lastError));
}

async function blueprintCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'validate': return validate(rest);
    case 'launch': return launch(rest);
    case 'sync': return sync(rest);
    default:
      throw new UsageError(
        sub === undefined ? 'missing blueprint subcommand' : `unknown blueprint subcommand "${sub}"`,
        'subcommands: validate, launch, sync',
      );
  }
}

export const blueprintCommands: CommandDef[] = [
  {
    name: 'blueprint',
    summary: 'Validate, launch and sync nav.yaml blueprints',
    usage: [VALIDATE_USAGE, LAUNCH_USAGE, SYNC_USAGE],
    run: blueprintCommand,
  },
];
