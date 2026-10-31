import type { User, Workspace } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import { ApiClient } from '../api.ts';
import type { CommandDef } from '../command.ts';
import { authContext } from '../context.ts';
import { DEFAULT_HOST, normalizeHost, readStoredConfig, writeStoredConfig } from '../config.ts';
import { CliError, UsageError } from '../errors.ts';
import { askSecret, isInteractive } from '../prompt.ts';
import { bold, dim, green, kv, out, printJson } from '../output.ts';

interface MeResponse {
  user: User;
  workspaces: Workspace[];
}

const LOGIN_USAGE = 'nav login [--host URL] [--token TOKEN] [--json]';

async function login(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { host: { type: 'string' }, token: { type: 'string' } });
  args.maxPositionals(0, LOGIN_USAGE);
  const stored = await readStoredConfig();
  const host = normalizeHost(args.str('host') || process.env.NAV_HOST || stored.host || DEFAULT_HOST);

  let token = (args.str('token') ?? '').trim();
  if (!token) {
    if (!isInteractive()) {
      throw new UsageError('no API token given', 'pass --token TOKEN, or run nav login in a terminal to be prompted');
    }
    token = (await askSecret('API token: ')).trim();
  }
  if (!token) throw new UsageError('API token is empty');

  const me = await new ApiClient({ host, token }).get<MeResponse>('/auth/me');
  const workspace = me.workspaces[0];
  if (!workspace) throw new CliError('this account has no workspaces');
  await writeStoredConfig({ host, token, workspaceId: workspace.id });

  if (args.bool('json')) {
    printJson({ host, user: me.user, workspace });
    return;
  }
  out(`${green('Logged in')} as ${bold(me.user.email)} on ${host}`);
  out(`${dim('Workspace')}  ${workspace.name} (${workspace.slug})`);
  if (me.workspaces.length > 1) {
    out(dim('Other workspaces: run nav workspaces, then nav workspace use <id|slug>'));
  }
}

async function logout(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  args.maxPositionals(0, 'nav logout [--json]');
  const stored = await readStoredConfig();
  const hadToken = Boolean(stored.token);
  if (hadToken) await writeStoredConfig({ host: stored.host });
  if (args.bool('json')) {
    printJson({ loggedOut: hadToken });
    return;
  }
  out(hadToken ? 'Logged out. The saved API token was removed.' : 'Not logged in.');
  if (process.env.NAV_TOKEN) {
    out(dim('NAV_TOKEN is still set in this environment; unset it to stop using it.'));
  }
}

async function whoami(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  args.maxPositionals(0, 'nav whoami [--json]');
  const { config, client } = await authContext();
  const me = await client.get<MeResponse>('/auth/me');
  const workspace = me.workspaces.find((w) => w.id === config.workspaceId) ?? null;
  if (args.bool('json')) {
    printJson({ host: config.host, user: me.user, workspace });
    return;
  }
  const name = me.user.name ? `${me.user.name} ` : '';
  out(kv([
    ['User', `${name}<${me.user.email}>`],
    ['Host', config.host],
    ['Workspace', workspace ? `${workspace.name} (${workspace.slug}, ${workspace.role})` : config.workspaceId],
  ]));
}

export const authCommands: CommandDef[] = [
  {
    name: 'login',
    summary: 'Save an API token and select a workspace',
    usage: [LOGIN_USAGE],
    run: login,
  },
  {
    name: 'logout',
    summary: 'Remove the saved API token from this machine',
    usage: ['nav logout [--json]'],
    run: logout,
  },
  {
    name: 'whoami',
    summary: 'Show the signed-in user, host and current workspace',
    usage: ['nav whoami [--json]'],
    run: whoami,
  },
];
