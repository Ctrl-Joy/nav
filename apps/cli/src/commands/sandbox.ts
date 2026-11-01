// `nav sandbox`: isolated, short-lived environments for running code, through the @nav/sandbox SDK.
import { readFile, writeFile } from 'node:fs/promises';
import { NavSandboxError, NavSandboxes, type Sandbox } from '@nav/sandbox';
import { parseCommandArgs, pick } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { workspaceContext } from '../context.ts';
import { CliError, UsageError } from '../errors.ts';
import { dim, green, out, printJson, relativeTime, statusText, table, truncate } from '../output.ts';

const LS_USAGE = 'nav sandbox ls [--all] [--json]';
const CREATE_USAGE = 'nav sandbox create [--runtime node|python|bash | --image <ref>] [--plan small] [--ttl <seconds>] [--env KEY=VALUE]... [--network none|egress] [--snapshot <id>] [--name <name>] [--json]';
const EXEC_USAGE = 'nav sandbox exec <id> [--cwd <dir>] [--timeout <seconds>] [--env KEY=VALUE]... [--stream] -- <command...>';
const CP_USAGE = 'nav sandbox cp <local-file> <id>:<path>  |  nav sandbox cp <id>:<path> <local-file|->';
const RM_USAGE = 'nav sandbox rm <id>...  |  nav sandbox rm <id>:<path> [--recursive]';
const SNAPSHOT_USAGE = 'nav sandbox snapshot <id> [--name <name>] [--json]';

async function client(): Promise<NavSandboxes> {
  const ctx = await workspaceContext();
  return new NavSandboxes({ host: ctx.config.host, token: ctx.config.token!, workspaceId: ctx.workspaceId });
}

/** Turns SDK errors into CLI errors (same exit codes and formatting as other commands). */
async function sdk<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NavSandboxError) throw new CliError(error.message, error.status === 409 ? 'is the sandbox still running? see nav sandbox ls' : undefined);
    throw error;
  }
}

function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new UsageError(`--env expects KEY=VALUE, got "${p}"`);
    env[p.slice(0, i)] = p.slice(i + 1);
  }
  return env;
}

function remaining(expiresAt: string): string {
  const s = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

// Quotes an argument for a POSIX shell, since the command runs in the sandbox.
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** "<id>:<path>" -> {id, path}; null for a local path (Windows drive letters are local). */
function remote(ref: string): { id: string; path: string } | null {
  const m = /^(sbx_[a-z0-9]+):(.*)$/.exec(ref);
  return m ? { id: m[1], path: m[2] } : null;
}

async function list(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { all: { type: 'boolean' } });
  args.maxPositionals(0, LS_USAGE);
  const nav = await client();
  const items = await sdk(() => nav.list({ status: args.bool('all') ? 'all' : 'live' }));
  if (args.bool('json')) return printJson(items);
  if (!items.length) return out(args.bool('all') ? 'No sandboxes yet.' : 'No live sandboxes. Create one with nav sandbox create.');
  out(table(
    ['id', 'name', 'status', 'image', 'plan', 'expires', 'execs', 'created'],
    items.map((s: Sandbox) => [s.id, s.name ?? '-', statusText(s.status), truncate(s.image, 28), s.plan, s.status === 'running' ? `in ${remaining(s.expiresAt)}` : '-', String(s.execCount), relativeTime(s.createdAt)]),
  ));
}

async function create(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    runtime: { type: 'string' }, image: { type: 'string' }, plan: { type: 'string' }, ttl: { type: 'string' },
    env: { type: 'string', multiple: true }, network: { type: 'string' }, snapshot: { type: 'string' }, name: { type: 'string' },
  });
  args.maxPositionals(0, CREATE_USAGE);
  const nav = await client();
  const sb = await sdk(() => nav.create({
    name: args.str('name'),
    runtime: args.str('runtime') ? pick('--runtime', args.str('runtime')!, ['node', 'python', 'bash']) as 'node' : undefined,
    image: args.str('image'),
    plan: args.str('plan'),
    ttlSeconds: args.int('ttl'),
    env: parseEnv(args.strs('env')),
    networkAccess: args.str('network') ? pick('--network', args.str('network')!, ['none', 'egress']) as 'none' : undefined,
    snapshotId: args.str('snapshot'),
  }));
  if (args.bool('json')) return printJson(sb.info);
  out(`${green('Created')} sandbox ${sb.id} (${sb.info.image}, ${sb.info.plan}, expires in ${remaining(sb.info.expiresAt)})`);
  if (!sb.info.isolated) out(dim('Note: this node runs sandboxes with the process driver, which is NOT isolated (development only).'));
  out(dim(`Run a command: nav sandbox exec ${sb.id} -- echo hello`));
}

async function exec(argv: string[]): Promise<void> {
  const separator = argv.indexOf('--');
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator + 1);
  const args = parseCommandArgs(head, { cwd: { type: 'string' }, timeout: { type: 'string' }, env: { type: 'string', multiple: true }, stream: { type: 'boolean' } });
  const id = args.arg(0, 'sandbox id', EXEC_USAGE);
  const parts = [...args.positionals.slice(1), ...tail];
  if (!parts.length) throw new UsageError('no command given', `usage: ${EXEC_USAGE}`);
  // A single argument is taken as a shell command line as-is; several are quoted word by word.
  const command = parts.length === 1 ? parts[0] : parts.map(shellQuote).join(' ');
  const nav = await client();
  const sb = await sdk(() => nav.get(id));
  const opts = { cwd: args.str('cwd'), timeoutSeconds: args.int('timeout'), env: parseEnv(args.strs('env')) };
  if (args.bool('stream')) {
    const ctrl = new AbortController();
    process.once('SIGINT', () => ctrl.abort());
    const r = await sdk(() => sb.execStream(command, { ...opts, signal: ctrl.signal, onStdout: (c) => process.stdout.write(c), onStderr: (c) => process.stderr.write(c) }));
    if (r.timedOut) process.stderr.write(dim('\n[timed out: the command was killed]\n'));
    process.exitCode = r.exitCode ?? 124;
    return;
  }
  const r = await sdk(() => sb.exec(command, opts));
  if (args.bool('json')) return printJson(r);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.stdoutTruncated || r.stderrTruncated) process.stderr.write(dim('\n[output truncated at 1 MiB per stream; use --stream for everything]\n'));
  if (r.timedOut) process.stderr.write(dim('\n[timed out: the command was killed]\n'));
  process.exitCode = r.exitCode ?? 124;
}

async function cp(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { mode: { type: 'string' } });
  const src = args.arg(0, 'source', CP_USAGE);
  const dst = args.arg(1, 'destination', CP_USAGE);
  args.maxPositionals(2, CP_USAGE);
  const from = remote(src);
  const to = remote(dst);
  if (!!from === !!to) throw new UsageError('exactly one side must be <sandbox-id>:<path>', `usage: ${CP_USAGE}`);
  const nav = await client();
  if (to) {
    const data = await readFile(src).catch(() => { throw new CliError(`cannot read ${src}`); });
    const sb = await sdk(() => nav.get(to.id));
    const mode = args.str('mode');
    await sdk(() => sb.writeFile(to.path, data, mode ? { mode: parseInt(mode, 8) } : {}));
    if (!args.bool('json')) out(`${green('Copied')} ${data.length} bytes to ${dst}`);
  } else {
    const sb = await sdk(() => nav.get(from!.id));
    const data = await sdk(() => sb.readFile(from!.path));
    if (dst === '-') process.stdout.write(data);
    else {
      await writeFile(dst, data);
      if (!args.bool('json')) out(`${green('Copied')} ${data.length} bytes to ${dst}`);
    }
  }
}

async function rm(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { recursive: { type: 'boolean', short: 'r' } });
  if (!args.positionals.length) throw new UsageError('missing sandbox id', `usage: ${RM_USAGE}`);
  const nav = await client();
  for (const ref of args.positionals) {
    const file = remote(ref);
    if (file) {
      const sb = await sdk(() => nav.get(file.id));
      await sdk(() => sb.removeFile(file.path, { recursive: args.bool('recursive') }));
      out(`${green('Deleted')} ${ref}`);
    } else {
      const sb = await sdk(() => nav.get(ref));
      await sdk(() => sb.delete());
      out(`${green('Deleted')} sandbox ${ref}`);
    }
  }
}

async function snapshot(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { name: { type: 'string' } });
  const id = args.arg(0, 'sandbox id', SNAPSHOT_USAGE);
  args.maxPositionals(1, SNAPSHOT_USAGE);
  const nav = await client();
  const sb = await sdk(() => nav.get(id));
  const snap = await sdk(() => sb.snapshot({ name: args.str('name') }));
  if (args.bool('json')) return printJson(snap);
  out(`${green('Saved')} snapshot ${snap.id} (${snap.sizeBytes ?? 0} bytes). Restore it with nav sandbox create --snapshot ${snap.id}`);
}

async function sandboxCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'ls':
    case 'list':
      return list(sub ? rest : []);
    case 'create': return create(rest);
    case 'exec': return exec(rest);
    case 'cp': return cp(rest);
    case 'rm': return rm(rest);
    case 'snapshot': return snapshot(rest);
    default:
      throw new UsageError(`unknown sandbox subcommand "${sub}"`, 'run nav help sandbox to see the subcommands');
  }
}

export const sandboxCommands: CommandDef[] = [
  {
    name: 'sandbox',
    summary: 'Run code in isolated, short-lived sandboxes',
    usage: [LS_USAGE, CREATE_USAGE, EXEC_USAGE, CP_USAGE, RM_USAGE, SNAPSHOT_USAGE, 'Example: nav sandbox exec sbx_123 -- python -c "print(42)"'],
    run: sandboxCommand,
  },
];
