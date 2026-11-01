// Manages standalone PostgreSQL clusters using the embedded-postgres binaries (initdb / pg_ctl / postgres), or any
// other PostgreSQL installation on the host (other major versions, client tools such as pg_basebackup / pg_dump /
// pg_upgrade that embedded-postgres does not ship).
// Used for the platform database in development and for user databases under the process driver.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isWin = os.platform() === 'win32';
const exe = (name: string) => (isWin ? `${name}.exe` : name);

export interface PgBinaries { initdb: string; pg_ctl: string; postgres: string }

/** One PostgreSQL installation (a bin directory) found on this host. */
export interface PgInstall { version: number; binDir: string; embedded: boolean }

export const toolPath = (inst: PgInstall, tool: string) => path.join(inst.binDir, exe(tool));
export const hasTool = (inst: PgInstall, tool: string) => existsSync(toolPath(inst, tool));

let cached: { at: number; list: PgInstall[] } | null = null;

/** Expands one `*` in a single path segment (enough for /usr/lib/postgresql/<v>/bin style layouts). */
function expand(pattern: string): string[] {
  const parts = pattern.split(/[\\/]/);
  const i = parts.findIndex((p) => p.includes('*'));
  if (i < 0) return [pattern];
  const parent = parts.slice(0, i).join(path.sep) || path.sep;
  const [pre, post] = parts[i].split('*');
  let names: string[] = [];
  try { names = readdirSync(parent); } catch { return []; }
  return names.filter((n) => n.startsWith(pre) && n.endsWith(post)).map((n) => [parent, n, ...parts.slice(i + 1)].join(path.sep));
}

function candidateDirs(): string[] {
  const env = (v: string | undefined) => (v ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  const common = isWin
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PostgreSQL', '*', 'bin')]
    : ['/usr/lib/postgresql/*/bin', '/usr/pgsql-*/bin', '/usr/local/pgsql/bin', '/opt/homebrew/opt/postgresql@*/bin', '/usr/local/opt/postgresql@*/bin', '/Applications/Postgres.app/Contents/Versions/*/bin'];
  return [...env(process.env.NAV_PG_BIN_DIRS), ...env(process.env.PATH), ...common.flatMap(expand)];
}

async function versionOf(binDir: string): Promise<number | null> {
  for (const tool of ['pg_ctl', 'postgres', 'pg_dump']) {
    const bin = path.join(binDir, exe(tool));
    if (!existsSync(bin)) continue;
    const r = await run(bin, ['--version']).catch(() => null);
    const m = r?.out.match(/\(PostgreSQL\)\s+(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Every PostgreSQL installation on this host: embedded-postgres first, then NAV_PG_BIN_DIRS (path-list), PATH and the
 * usual install locations. Cached for a minute.
 */
export async function pgInstalls(refresh = false): Promise<PgInstall[]> {
  if (cached && !refresh && Date.now() - cached.at < 60_000) return cached.list;
  const list: PgInstall[] = [];
  const seen = new Set<string>();
  const add = async (binDir: string, embedded: boolean) => {
    const key = path.resolve(binDir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!existsSync(path.join(binDir, exe('pg_ctl'))) && !existsSync(path.join(binDir, exe('pg_dump')))) return;
    const version = await versionOf(binDir);
    if (version) list.push({ version, binDir: path.resolve(binDir), embedded });
  };
  try {
    const plat = os.platform() === 'win32' ? 'windows' : os.platform();
    const mod = await import(`@embedded-postgres/${plat}-${os.arch()}`);
    await add(path.dirname(mod.pg_ctl), true);
  } catch { /* embedded-postgres not installed for this platform */ }
  for (const d of candidateDirs()) await add(d, false);
  cached = { at: Date.now(), list };
  return list;
}

/** The installation that runs servers of `version` (initdb + pg_ctl + postgres). Default: embedded-postgres. */
export async function pgServerInstall(version?: number): Promise<PgInstall> {
  const all = (await pgInstalls()).filter((i) => hasTool(i, 'initdb') && hasTool(i, 'pg_ctl') && hasTool(i, 'postgres'));
  const pick = version == null ? all[0] : all.find((i) => i.version === version);
  if (!pick) throw new Error(version == null ? 'no PostgreSQL server binaries found' : `PostgreSQL ${version} server binaries are not installed on this node`);
  return pick;
}

/**
 * Finds a client tool: the same major version first, otherwise the lowest newer one (pg_dump / pg_basebackup work
 * against older servers). `exact` forbids the fallback (pg_upgrade must be the target version's).
 */
export async function pgTool(tool: string, version: number, exact = false): Promise<string | null> {
  const all = (await pgInstalls()).filter((i) => hasTool(i, tool));
  const same = all.find((i) => i.version === version);
  if (same) return toolPath(same, tool);
  if (exact) return null;
  const newer = all.filter((i) => i.version > version).sort((a, b) => a.version - b.version)[0];
  return newer ? toolPath(newer, tool) : null;
}

/** pg_repack / extensions such as postgis live in a specific installation; true when its share dir has the control file. */
export function hasExtension(inst: PgInstall, name: string): boolean {
  return existsSync(path.join(inst.binDir, '..', 'share', 'extension', `${name}.control`))
    || existsSync(path.join(inst.binDir, '..', 'share', 'postgresql', 'extension', `${name}.control`));
}

/** pg_upgrade runs these from the old (-b) and new (-B) bin directories, so both must be complete installations. */
export const PG_UPGRADE_TOOLS = ['initdb', 'pg_ctl', 'postgres', 'pg_controldata', 'pg_resetwal', 'pg_dump', 'pg_dumpall', 'pg_restore', 'psql', 'vacuumdb'];
export const isFullInstall = (i: PgInstall) => PG_UPGRADE_TOOLS.every((t) => hasTool(i, t));

const binariesIn = (binDir: string): PgBinaries => ({ initdb: path.join(binDir, exe('initdb')), pg_ctl: path.join(binDir, exe('pg_ctl')), postgres: path.join(binDir, exe('postgres')) });

export async function pgBinaries(version?: number): Promise<PgBinaries> {
  return binariesIn((await pgServerInstall(version)).binDir);
}

/** Major version of an initialised data directory (PG_VERSION), or null. */
export async function clusterVersion(dataDir: string): Promise<number | null> {
  const v = await readFile(path.join(dataDir, 'PG_VERSION'), 'utf8').catch(() => null);
  return v ? Number(v.trim()) : null;
}

/** Binaries matching the cluster's own version (falls back to the default installation). */
async function binariesFor(dataDir: string): Promise<PgBinaries> {
  const v = await clusterVersion(dataDir);
  return pgBinaries(v ?? undefined).catch(() => pgBinaries());
}

export function runPg(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; onLine?: (l: string) => void; cwd?: string } = {}): Promise<{ code: number; out: string }> {
  return run(bin, args, opts);
}

function run(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; onLine?: (l: string) => void; cwd?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...opts.env }, windowsHide: true, cwd: opts.cwd });
    let out = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
      if (out.length > 1_000_000) out = out.slice(-500_000);
      if (opts.onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) opts.onLine(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    // 'exit', not 'close': pg_ctl start leaves the server holding the inherited stdio pipes open.
    child.on('exit', (code) => setTimeout(() => resolve({ code: code ?? 1, out }), 50));
  });
}

export interface ClusterSpec {
  dataDir: string;
  port: number;
  superuser: string;
  password: string;
  listen?: string;            // listen_addresses, default '*'
  allowList?: string[];       // CIDRs allowed for remote password auth
  memoryMB?: number;
  /** Major version; the matching installation's binaries are used (default: embedded-postgres). */
  version?: number;
  /** A specific installation's bin directory (overrides `version`). */
  binDir?: string;
  /** Continuous WAL archiving into this directory (point-in-time recovery). */
  archiveDir?: string;
  /** shared_preload_libraries, e.g. pg_stat_statements. */
  preload?: string[];
  /** Run as a streaming standby of another cluster. */
  standby?: { conninfo: string; slot?: string };
  /** Archive recovery from a WAL archive, optionally stopping at a point in time (then promote). */
  recovery?: { restoreDir: string; targetTime?: string };
  /** Upper bound for WAL retained by replication slots (a replica falling further behind must be rebuilt). */
  maxSlotWalKeepMB?: number;
}

/** A postgresql.conf string literal (the config parser treats backslash as an escape character). */
export const confStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/** archive_command copying a finished WAL segment into `dir` (cmd.exe on Windows, sh elsewhere). */
export function archiveCommand(dir: string, platform: NodeJS.Platform = os.platform()): string {
  if (platform === 'win32') return `copy /Y "%p" "${dir.replace(/\//g, '\\')}\\%f" >NUL`;
  return `test ! -f '${dir}/%f' && cp '%p' '${dir}/%f'`;
}

/** restore_command fetching a WAL segment from `dir` during archive recovery. */
export function restoreCommand(dir: string, platform: NodeJS.Platform = os.platform()): string {
  if (platform === 'win32') return `copy /Y "${dir.replace(/\//g, '\\')}\\%f" "%p" >NUL 2>NUL`;
  return `cp '${dir}/%f' '%p'`;
}

/** recovery_target_time does not accept ISO 8601 "T…Z": 2026-11-01T10:00:00.000Z → 2026-11-01 10:00:00.000+00. */
export function pgTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '+00');
}

/** The NAV-managed postgresql.conf settings for a spec (exported for tests). */
export function configLines(spec: ClusterSpec): string[] {
  const sharedBuffers = Math.max(16, Math.floor((spec.memoryMB ?? 256) / 4));
  const conf = [
    `listen_addresses = '${spec.listen ?? '*'}'`,
    `port = ${spec.port}`,
    'max_connections = 100',
    `shared_buffers = ${sharedBuffers}MB`,
    'password_encryption = scram-sha-256',
    'logging_collector = off',
    "log_line_prefix = '%m [%p] %q%u@%d '",
    'log_min_duration_statement = 2000',
    'wal_level = replica',
    'max_wal_senders = 10',
    'max_replication_slots = 10',
    'hot_standby = on',
    'wal_log_hints = on',
  ];
  if (spec.maxSlotWalKeepMB) conf.push(`max_slot_wal_keep_size = ${spec.maxSlotWalKeepMB}MB`);
  if (spec.archiveDir) {
    conf.push('archive_mode = on', `archive_command = ${confStr(archiveCommand(spec.archiveDir))}`, 'archive_timeout = 60');
  } else conf.push('archive_mode = off');
  if (spec.preload?.length) conf.push(`shared_preload_libraries = ${confStr(spec.preload.join(','))}`, 'pg_stat_statements.track = top');
  if (spec.standby) {
    conf.push(`primary_conninfo = ${confStr(spec.standby.conninfo)}`, 'hot_standby_feedback = on');
    if (spec.standby.slot) conf.push(`primary_slot_name = ${confStr(spec.standby.slot)}`);
  }
  if (spec.recovery) {
    conf.push(`restore_command = ${confStr(restoreCommand(spec.recovery.restoreDir))}`, "recovery_target_timeline = 'latest'");
    if (spec.recovery.targetTime) conf.push(`recovery_target_time = ${confStr(pgTimestamp(spec.recovery.targetTime))}`, "recovery_target_action = 'promote'", 'recovery_target_inclusive = on');
  }
  return conf;
}

export async function initCluster(spec: ClusterSpec, log: (l: string) => void = () => {}, extraArgs: string[] = []): Promise<void> {
  const bin = spec.binDir ? binariesIn(spec.binDir) : await pgBinaries(spec.version);
  if (existsSync(path.join(spec.dataDir, 'PG_VERSION'))) return;
  await mkdir(spec.dataDir, { recursive: true });
  const pwfile = path.join(path.dirname(spec.dataDir), `.pw-${path.basename(spec.dataDir)}`);
  await writeFile(pwfile, spec.password + '\n', { mode: 0o600 });
  try {
    const r = await run(bin.initdb, ['-D', spec.dataDir, '-U', spec.superuser, `--pwfile=${pwfile}`, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C', ...extraArgs], { onLine: log, env: { LC_ALL: 'C' } });
    if (r.code !== 0) throw new Error(`initdb failed: ${r.out.slice(-800)}`);
  } finally {
    await rm(pwfile, { force: true });
  }
  await writeConfig(spec);
}

/** Rewrites the NAV-managed part of postgresql.conf and the whole pg_hba.conf (IP allow list). */
export async function writeConfig(spec: ClusterSpec): Promise<void> {
  const conf = configLines(spec).join('\n');
  const base = path.join(spec.dataDir, 'postgresql.conf');
  const current = await readFile(base, 'utf8');
  const marker = '# --- NAV managed ---';
  const head = current.split(marker)[0];
  await writeFile(base, `${head}${marker}\n${conf}\n`);
  if (spec.archiveDir) await mkdir(spec.archiveDir, { recursive: true });
  const remote = (spec.allowList ?? []).filter((c) => c && c !== '127.0.0.1/32');
  const hba = [
    '# NAV managed pg_hba.conf',
    'host    all all 127.0.0.1/32    scram-sha-256',
    'host    all all ::1/128         scram-sha-256',
    ...remote.map((cidr) => `host    all all ${cidr.padEnd(18)} scram-sha-256`),
    'host    replication all 127.0.0.1/32 scram-sha-256',
  ];
  if (os.platform() !== 'win32') hba.splice(1, 0, 'local   all all                 scram-sha-256');
  await writeFile(path.join(spec.dataDir, 'pg_hba.conf'), hba.join('\n') + '\n');
}

/** Removes settings from postgresql.auto.conf (e.g. the primary_conninfo pg_basebackup -R writes there). */
export async function stripAutoConf(dataDir: string, keys: string[]): Promise<void> {
  const file = path.join(dataDir, 'postgresql.auto.conf');
  const cur = await readFile(file, 'utf8').catch(() => null);
  if (cur == null) return;
  const re = new RegExp(`^\\s*(${keys.join('|')})\\s*=`);
  await writeFile(file, cur.split(/\r?\n/).filter((l) => !re.test(l)).join('\n'));
}

export async function startCluster(spec: ClusterSpec, log: (l: string) => void = () => {}): Promise<void> {
  const bin = spec.binDir ? binariesIn(spec.binDir) : spec.version ? await pgBinaries(spec.version) : await binariesFor(spec.dataDir);
  if (await isRunning(spec.dataDir)) return;
  const logFile = path.join(spec.dataDir, 'server.log');
  const r = await run(bin.pg_ctl, ['start', '-D', spec.dataDir, '-l', logFile, '-w', '-t', '60', '-o', `-p ${spec.port}`], { onLine: log });
  if (r.code !== 0) {
    const tail = await readFile(logFile, 'utf8').catch(() => '');
    throw new Error(`pg_ctl start failed: ${r.out.slice(-400)} ${tail.slice(-800)}`);
  }
}

export async function stopCluster(dataDir: string, mode: 'fast' | 'immediate' = 'fast'): Promise<void> {
  const bin = await binariesFor(dataDir);
  if (!(await isRunning(dataDir))) return;
  await run(bin.pg_ctl, ['stop', '-D', dataDir, '-m', mode, '-w', '-t', '60']);
}

export async function reloadCluster(dataDir: string): Promise<void> {
  const bin = await binariesFor(dataDir);
  await run(bin.pg_ctl, ['reload', '-D', dataDir]);
}

export async function isRunning(dataDir: string): Promise<boolean> {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) return false;
  const bin = await binariesFor(dataDir);
  const r = await run(bin.pg_ctl, ['status', '-D', dataDir]);
  return r.code === 0;
}
