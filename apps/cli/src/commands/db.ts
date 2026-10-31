import { spawn } from 'node:child_process';
import type { Database, DatabaseCredentials, DbBackup } from '@nav/shared';
import { parseCommandArgs } from '../args.ts';
import { listAll } from '../api.ts';
import type { CommandDef } from '../command.ts';
import { findDatabase, workspaceContext } from '../context.ts';
import { UsageError } from '../errors.ts';
import { bold, dim, err, green, kv, out, printJson, relativeTime, statusText, table } from '../output.ts';

const LIST_USAGE = 'nav db list [--json]';
const CREATE_USAGE = 'nav db create --name NAME [--plan PLAN] [--version N] [--json]';
const INFO_USAGE = 'nav db info <id|name> [--json]';
const PSQL_USAGE = 'nav db psql <id|name>';
const BACKUP_USAGE = 'nav db backup <id|name> [--json]';
const QUERY_USAGE = 'nav db query <id|name> "SQL" [--json]';

interface QueryResult {
  columns: Array<string | { name: string }>;
  rows: unknown[];
  rowCount: number;
  durationMs: number;
}

async function listDatabases(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  args.maxPositionals(0, LIST_USAGE);
  const ctx = await workspaceContext();
  const items = await listAll<Database>(ctx.client, `/workspaces/${ctx.workspaceId}/databases`);
  if (args.bool('json')) {
    printJson(items);
    return;
  }
  if (items.length === 0) {
    out('No databases yet. Create one with nav db create --name NAME.');
    return;
  }
  out(table(
    ['name', 'id', 'plan', 'postgres', 'status', 'disk', 'created'],
    items.map((d) => [
      bold(d.name),
      d.id,
      d.plan,
      String(d.pgVersion),
      statusText(d.status),
      `${d.diskGB} GB`,
      relativeTime(d.createdAt),
    ]),
  ));
}

async function createDatabase(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    name: { type: 'string' },
    plan: { type: 'string' },
    version: { type: 'string' },
  });
  args.maxPositionals(0, CREATE_USAGE);
  const name = args.str('name');
  if (!name) throw new UsageError('--name is required', `usage: ${CREATE_USAGE}`);
  const pgVersion = args.int('version');
  const body: Record<string, unknown> = { name };
  const plan = args.str('plan');
  if (plan !== undefined) body.plan = plan;
  if (pgVersion !== undefined) body.pgVersion = pgVersion;
  const ctx = await workspaceContext();
  const db = await ctx.client.post<Database>(`/workspaces/${ctx.workspaceId}/databases`, body);
  if (args.bool('json')) {
    printJson(db);
    return;
  }
  out(`${green('Creating')} database ${bold(db.name)} (${db.id}), status ${db.status}`);
  out(dim(`Check progress with nav db list; connection details with nav db info ${db.name}`));
}

async function databaseInfo(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'database', INFO_USAGE);
  args.maxPositionals(1, INFO_USAGE);
  const ctx = await workspaceContext();
  const db = await findDatabase(ctx, ref);
  const creds = await ctx.client.get<DatabaseCredentials>(`/databases/${db.id}/credentials`);
  if (args.bool('json')) {
    printJson({ databaseId: db.id, ...creds });
    return;
  }
  out(kv([
    ['Name', db.name],
    ['ID', db.id],
    ['Host', creds.host],
    ['Port', String(creds.port)],
    ['Database', creds.database],
    ['User', creds.user],
    ['Password', creds.password],
    ['External URL', creds.externalUrl],
    ['Internal URL', creds.internalUrl],
    ['psql', creds.psqlCommand],
  ]));
}

// Runs the local psql client against the external URL, or prints the URL when psql is missing.
async function openPsql(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'database', PSQL_USAGE);
  args.maxPositionals(1, PSQL_USAGE);
  const ctx = await workspaceContext();
  const db = await findDatabase(ctx, ref);
  const creds = await ctx.client.get<DatabaseCredentials>(`/databases/${db.id}/credentials`);
  const outcome = await new Promise<{ kind: 'exit'; code: number | null } | { kind: 'missing' } | { kind: 'failed'; message: string }>((resolve) => {
    const child = spawn('psql', [creds.externalUrl], { stdio: 'inherit' });
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', message: error.message });
    });
    child.once('close', (code) => resolve({ kind: 'exit', code }));
  });
  if (outcome.kind === 'exit') {
    process.exitCode = outcome.code ?? 1;
    return;
  }
  if (outcome.kind === 'failed') throw new UsageError(`could not start psql: ${outcome.message}`);
  out('psql was not found on your PATH. Connect with:');
  out(creds.externalUrl);
  process.exitCode = 1;
}

async function backupDatabase(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'database', BACKUP_USAGE);
  args.maxPositionals(1, BACKUP_USAGE);
  const ctx = await workspaceContext();
  const db = await findDatabase(ctx, ref);
  const backup = await ctx.client.post<DbBackup>(`/databases/${db.id}/backups`);
  if (args.bool('json')) {
    printJson(backup);
    return;
  }
  out(`${green('Backup started')} for ${db.name}: ${backup.id} (${statusText(backup.status)})`);
}

function cellText(row: unknown, index: number, name: string): string {
  const value = Array.isArray(row) ? row[index] : (row as Record<string, unknown> | null)?.[name];
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function queryDatabase(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'database', QUERY_USAGE);
  const sql = args.positionals.slice(1).join(' ').trim();
  if (!sql) throw new UsageError('no SQL given', `usage: ${QUERY_USAGE}`);
  const ctx = await workspaceContext();
  const db = await findDatabase(ctx, ref);
  const result = await ctx.client.post<QueryResult>(`/databases/${db.id}/query`, { sql });
  if (args.bool('json')) {
    printJson(result);
    return;
  }
  const names = result.columns.map((c) => (typeof c === 'string' ? c : c.name));
  if (names.length === 0) {
    out(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected in ${result.durationMs} ms`);
    return;
  }
  out(table(names, result.rows.map((row) => names.map((name, i) => cellText(row, i, name)))));
  const shown = result.rows.length;
  const truncated = result.rowCount > shown ? `, showing the first ${shown}` : '';
  out(dim(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${result.durationMs} ms${truncated}`));
  if (truncated) err(dim('Results are capped at 1000 rows.'));
}

async function dbCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return listDatabases(sub === 'list' ? rest : []);
    case 'create': return createDatabase(rest);
    case 'info': return databaseInfo(rest);
    case 'psql': return openPsql(rest);
    case 'backup': return backupDatabase(rest);
    case 'query': return queryDatabase(rest);
    default:
      throw new UsageError(`unknown db subcommand "${sub}"`, 'run nav help db to see the subcommands');
  }
}

export const dbCommands: CommandDef[] = [
  {
    name: 'db',
    summary: 'Manage Postgres databases',
    usage: [LIST_USAGE, CREATE_USAGE, INFO_USAGE, PSQL_USAGE, BACKUP_USAGE, QUERY_USAGE],
    run: dbCommand,
  },
];
