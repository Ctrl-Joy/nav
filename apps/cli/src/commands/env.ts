import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Deploy, EnvVar } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext } from '../context.ts';
import { parseDotEnv, parseKeyValue, serializeDotEnv, type EnvPair } from '../dotenv.ts';
import { CliError, UsageError } from '../errors.ts';
import { err, green, dim, out, printJson, table, yellow } from '../output.ts';

const LIST_USAGE = 'nav env <service> [--json]';
const SET_USAGE = 'nav env set <service> KEY=VAL... [--no-deploy] [--json]';
const UNSET_USAGE = 'nav env unset <service> KEY... [--no-deploy] [--json]';
const PULL_USAGE = 'nav env pull <service> [--file .env] [--json]';
const PUSH_USAGE = 'nav env push <service> [--file .env] [--prune] [--no-deploy] [--json]';

// Viewers receive values masked as "***".
const MASKED = '***';

interface EnvListResponse {
  items: EnvVar[];
}

// PATCH and PUT on env-vars return the queued deploy when one was created.
type MutationResponse = { deploy?: Deploy | null } | undefined;

async function listVars(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', LIST_USAGE);
  args.maxPositionals(1, LIST_USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const { items } = await ctx.client.get<EnvListResponse>(`/services/${svc.id}/env-vars`);
  if (args.bool('json')) {
    printJson(items);
    return;
  }
  if (items.length === 0) {
    out(`No environment variables set on ${svc.name}.`);
    return;
  }
  out(table(['key', 'value'], items.map((v) => [v.key, v.value])));
}

// `message` is a full sentence fragment such as "Set 2 variables" or "Removed FOO".
function reportChange(json: boolean, serviceName: string, message: string, deployed: boolean, result: MutationResponse): void {
  if (json) {
    printJson({ service: serviceName, message, deploy: result?.deploy ?? null });
    return;
  }
  out(`${green(message)} on ${serviceName}`);
  if (result?.deploy) {
    out(`Deploy ${result.deploy.id} queued. Follow it with nav logs ${serviceName} --tail`);
  } else if (!deployed) {
    out(dim(`Not redeployed. Run nav deploy ${serviceName} to apply the change.`));
  }
}

async function setVars(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { 'no-deploy': { type: 'boolean' } });
  const ref = args.arg(0, 'service', SET_USAGE);
  const pairs = args.positionals.slice(1).map(parseKeyValue);
  if (pairs.length === 0) throw new UsageError('no KEY=VAL pairs given', `usage: ${SET_USAGE}`);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const deploy = !args.bool('no-deploy');
  const result = await ctx.client.patch<MutationResponse>(`/services/${svc.id}/env-vars`, { set: pairs, deploy });
  const count = `${pairs.length} variable${pairs.length === 1 ? '' : 's'}`;
  reportChange(args.bool('json'), svc.name, `Set ${count}`, deploy, result);
}

async function unsetVars(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { 'no-deploy': { type: 'boolean' } });
  const ref = args.arg(0, 'service', UNSET_USAGE);
  const keys = args.positionals.slice(1);
  if (keys.length === 0) throw new UsageError('no variable names given', `usage: ${UNSET_USAGE}`);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const deploy = !args.bool('no-deploy');
  const result = await ctx.client.patch<MutationResponse>(`/services/${svc.id}/env-vars`, { remove: keys, deploy });
  reportChange(args.bool('json'), svc.name, `Removed ${keys.join(', ')}`, deploy, result);
}

async function pullVars(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { file: { type: 'string' } });
  const ref = args.arg(0, 'service', PULL_USAGE);
  args.maxPositionals(1, PULL_USAGE);
  const file = args.str('file') ?? '.env';
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const { items } = await ctx.client.get<EnvListResponse>(`/services/${svc.id}/env-vars`);
  const pairs: EnvPair[] = items.map((v) => ({ key: v.key, value: v.value }));
  const path = resolve(file);
  await writeFile(path, serializeDotEnv(pairs), { mode: 0o600 });
  const masked = pairs.some((p) => p.value === MASKED);
  if (args.bool('json')) {
    printJson({ file: path, count: pairs.length, masked });
    return;
  }
  out(`Wrote ${pairs.length} variable${pairs.length === 1 ? '' : 's'} to ${path}`);
  if (masked) {
    err(yellow('Some values are masked as *** because your role cannot read them. Do not push this file back.'));
  }
}

async function pushVars(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    file: { type: 'string' },
    prune: { type: 'boolean' },
    'no-deploy': { type: 'boolean' },
  });
  const ref = args.arg(0, 'service', PUSH_USAGE);
  args.maxPositionals(1, PUSH_USAGE);
  const file = args.str('file') ?? '.env';
  const path = resolve(file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`cannot read ${file}`, 'create the file, or pass --file PATH');
  }
  const desired = parseDotEnv(text);
  if (desired.length === 0) throw new CliError(`${file} contains no variables`);
  const masked = desired.find((p) => p.value === MASKED);
  if (masked) {
    throw new UsageError(
      `${masked.key} is the masked placeholder ***`,
      'replace it with the real value before pushing; masked values come from env pull by a viewer',
    );
  }

  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const { items: remote } = await ctx.client.get<EnvListResponse>(`/services/${svc.id}/env-vars`);
  const current = new Map(remote.map((v) => [v.key, v.value]));
  const set = desired.filter((p) => current.get(p.key) !== p.value);
  const wanted = new Set(desired.map((p) => p.key));
  const remove = args.bool('prune') ? remote.map((v) => v.key).filter((key) => !wanted.has(key)) : [];
  const deploy = !args.bool('no-deploy');

  if (set.length === 0 && remove.length === 0) {
    if (args.bool('json')) printJson({ service: svc.name, set: [], remove: [], deploy: null });
    else out('Nothing to change.');
    return;
  }
  const result = await ctx.client.patch<MutationResponse>(`/services/${svc.id}/env-vars`, { set, remove, deploy });
  const parts = [`${set.length} set`];
  if (remove.length > 0) parts.push(`${remove.length} removed`);
  reportChange(args.bool('json'), svc.name, `Pushed ${file} (${parts.join(', ')})`, deploy, result);
}

async function envCommand(argv: string[]): Promise<void> {
  switch (argv[0]) {
    case 'set': return setVars(argv.slice(1));
    case 'unset': return unsetVars(argv.slice(1));
    case 'pull': return pullVars(argv.slice(1));
    case 'push': return pushVars(argv.slice(1));
    default: return listVars(argv);
  }
}

export const envCommands: CommandDef[] = [
  {
    name: 'env',
    summary: 'List, set, unset, pull and push environment variables',
    usage: [LIST_USAGE, SET_USAGE, UNSET_USAGE, PULL_USAGE, PUSH_USAGE],
    run: envCommand,
  },
];
