import type { Workspace } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import { listAll } from '../api.ts';
import type { CommandDef } from '../command.ts';
import { authContext, matchByRef } from '../context.ts';
import { updateStoredConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { dim, green, out, printJson, table } from '../output.ts';

async function listWorkspaces(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  args.maxPositionals(0, 'nav workspaces [--json]');
  const { config, client } = await authContext();
  const items = await listAll<Workspace>(client, '/workspaces');
  if (args.bool('json')) {
    printJson(items.map((w) => ({ ...w, current: w.id === config.workspaceId })));
    return;
  }
  if (items.length === 0) {
    out('No workspaces.');
    return;
  }
  out(table(
    ['current', 'name', 'slug', 'role', 'id'],
    items.map((w) => [w.id === config.workspaceId ? '*' : '', w.name, w.slug, w.role, w.id]),
  ));
}

const USE_USAGE = 'nav workspace use <id|slug>';

async function workspace(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== 'use') {
    throw new UsageError(
      sub === undefined ? 'missing subcommand' : `unknown workspace subcommand "${sub}"`,
      `usage: ${USE_USAGE}`,
    );
  }
  const args = parseCommandArgs(rest);
  const ref = args.arg(0, 'workspace id or slug', USE_USAGE);
  args.maxPositionals(1, USE_USAGE);
  const { config, client } = await authContext();
  const items = await listAll<Workspace>(client, '/workspaces');
  const chosen = matchByRef(items, ref, 'workspace', 'run nav workspaces to list workspaces');
  await updateStoredConfig({ workspaceId: chosen.id });
  if (args.bool('json')) {
    printJson({ workspace: chosen });
    return;
  }
  out(`${green('Using')} workspace ${chosen.name} (${chosen.slug})`);
  if (config.workspaceFromEnv) {
    out(dim('Note: NAV_WORKSPACE is set and overrides this selection in the current shell.'));
  }
}

export const workspaceCommands: CommandDef[] = [
  {
    name: 'workspaces',
    summary: 'List workspaces you belong to',
    usage: ['nav workspaces [--json]'],
    run: listWorkspaces,
  },
  {
    name: 'workspace',
    summary: 'Select the current workspace',
    usage: [USE_USAGE + ' [--json]'],
    run: workspace,
  },
];
