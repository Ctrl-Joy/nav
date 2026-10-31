// Manages standalone PostgreSQL clusters using the embedded-postgres binaries (initdb / pg_ctl / postgres).
// Used for the platform database in development and for user databases under the process driver.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface PgBinaries { initdb: string; pg_ctl: string; postgres: string }

export async function pgBinaries(): Promise<PgBinaries> {
  const plat = os.platform() === 'win32' ? 'windows' : os.platform();
  const mod = await import(`@embedded-postgres/${plat}-${os.arch()}`);
  return { initdb: mod.initdb, pg_ctl: mod.pg_ctl, postgres: mod.postgres };
}

function run(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; onLine?: (l: string) => void } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...opts.env }, windowsHide: true });
    let out = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
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
}

export async function initCluster(spec: ClusterSpec, log: (l: string) => void = () => {}): Promise<void> {
  const bin = await pgBinaries();
  if (existsSync(path.join(spec.dataDir, 'PG_VERSION'))) return;
  await mkdir(spec.dataDir, { recursive: true });
  const pwfile = path.join(path.dirname(spec.dataDir), `.pw-${path.basename(spec.dataDir)}`);
  await writeFile(pwfile, spec.password + '\n', { mode: 0o600 });
  try {
    const r = await run(bin.initdb, ['-D', spec.dataDir, '-U', spec.superuser, `--pwfile=${pwfile}`, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C'], { onLine: log, env: { LC_ALL: 'C' } });
    if (r.code !== 0) throw new Error(`initdb failed: ${r.out.slice(-800)}`);
  } finally {
    await rm(pwfile, { force: true });
  }
  await writeConfig(spec);
}

/** Rewrites the NAV-managed part of postgresql.conf and the whole pg_hba.conf (IP allow list). */
export async function writeConfig(spec: ClusterSpec): Promise<void> {
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
    'max_wal_senders = 3',
  ].join('\n');
  const base = path.join(spec.dataDir, 'postgresql.conf');
  const current = await readFile(base, 'utf8');
  const marker = '# --- NAV managed ---';
  const head = current.split(marker)[0];
  await writeFile(base, `${head}${marker}\n${conf}\n`);
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

export async function startCluster(spec: ClusterSpec, log: (l: string) => void = () => {}): Promise<void> {
  const bin = await pgBinaries();
  if (await isRunning(spec.dataDir)) return;
  const logFile = path.join(spec.dataDir, 'server.log');
  const r = await run(bin.pg_ctl, ['start', '-D', spec.dataDir, '-l', logFile, '-w', '-t', '60', '-o', `-p ${spec.port}`], { onLine: log });
  if (r.code !== 0) {
    const tail = await readFile(logFile, 'utf8').catch(() => '');
    throw new Error(`pg_ctl start failed: ${r.out.slice(-400)} ${tail.slice(-800)}`);
  }
}

export async function stopCluster(dataDir: string, mode: 'fast' | 'immediate' = 'fast'): Promise<void> {
  const bin = await pgBinaries();
  if (!(await isRunning(dataDir))) return;
  await run(bin.pg_ctl, ['stop', '-D', dataDir, '-m', mode, '-w', '-t', '60']);
}

export async function reloadCluster(dataDir: string): Promise<void> {
  const bin = await pgBinaries();
  await run(bin.pg_ctl, ['reload', '-D', dataDir]);
}

export async function isRunning(dataDir: string): Promise<boolean> {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) return false;
  const bin = await pgBinaries();
  const r = await run(bin.pg_ctl, ['status', '-D', dataDir]);
  return r.code === 0;
}
