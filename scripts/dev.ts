// NAV local launcher: boots the platform Postgres, applies migrations and runs control, agent, edge and web
// with prefixed, colored output. Usage: npm run dev  (flags: --no-web, --only=control,agent)
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.nav');
const envFile = path.join(dataDir, 'platform.env');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const noWeb = args.includes('--no-web');

async function loadOrCreateEnv(): Promise<Record<string, string>> {
  await mkdir(dataDir, { recursive: true });
  if (existsSync(envFile)) {
    const env: Record<string, string> = {};
    for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    return env;
  }
  const env = {
    NAV_PG_PASSWORD: randomBytes(18).toString('base64url'),
    NAV_MASTER_KEY: randomBytes(32).toString('hex'),
  };
  await writeFile(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return env;
}

const secrets = await loadOrCreateEnv();
const pgPort = Number(process.env.NAV_PG_PORT ?? 5433);
const databaseUrl = process.env.NAV_DATABASE_URL ?? `postgres://nav:${secrets.NAV_PG_PASSWORD}@127.0.0.1:${pgPort}/nav`;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NAV_DATA_DIR: dataDir,
  NAV_DATABASE_URL: databaseUrl,
  NAV_MASTER_KEY: process.env.NAV_MASTER_KEY ?? secrets.NAV_MASTER_KEY,
  FORCE_COLOR: '1',
};

if (!process.env.NAV_DATABASE_URL) {
  const { initCluster, startCluster } = await import('../apps/control/src/lib/pgcluster.ts');
  const spec = { dataDir: path.join(dataDir, 'platform-pg'), port: pgPort, superuser: 'nav', password: secrets.NAV_PG_PASSWORD, listen: '127.0.0.1' };
  console.log(`[dev] platform postgres on 127.0.0.1:${pgPort}`);
  await initCluster(spec, (l) => console.log(`[pg] ${l}`));
  await startCluster(spec);
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: `postgres://nav:${secrets.NAV_PG_PASSWORD}@127.0.0.1:${pgPort}/postgres` });
  await c.connect();
  const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = 'nav'");
  if (!exists.rowCount) await c.query('CREATE DATABASE nav');
  await c.end();
}

process.env.NAV_DATABASE_URL = databaseUrl;
process.env.NAV_DATA_DIR = dataDir;
const { migrate } = await import('../apps/control/src/db/migrate.ts');
const { pool } = await import('../apps/control/src/db/pool.ts');
await migrate();
await pool.end();

const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m'];
const procs: { name: string; cmd: string; args: string[]; cwd: string }[] = [
  { name: 'control', cmd: process.execPath, args: ['src/main.ts'], cwd: path.join(root, 'apps/control') },
  { name: 'agent', cmd: process.execPath, args: ['src/agent/main.ts'], cwd: path.join(root, 'apps/control') },
  { name: 'edge', cmd: process.execPath, args: ['src/main.ts'], cwd: path.join(root, 'apps/edge') },
  { name: 'web', cmd: process.execPath, args: [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', '5180', '--strictPort'], cwd: path.join(root, 'apps/web') },
].filter((p) => (only ? only.includes(p.name) : !(noWeb && p.name === 'web')));

// Refuse to start if another program already owns one of our ports (on Windows a second process can bind the
// same port on a different address, silently shadowing ours).
const net = await import('node:net');
const portOwner = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
const ports: [string, number][] = [['control', Number(process.env.NAV_API_PORT ?? 4000)], ['edge', Number(process.env.NAV_EDGE_HTTP_PORT ?? 7080)], ['edge', Number(process.env.NAV_EDGE_HTTPS_PORT ?? 7443)], ['web', 5180]];
for (const [name, port] of ports) {
  if (procs.some((p) => p.name === name) && (await portOwner(port))) {
    console.error(`[dev] port ${port} (${name}) is already in use by another program — stop it or set the matching NAV_*_PORT variable`);
    process.exit(1);
  }
}

const children: ChildProcess[] = [];
procs.forEach((p, i) => {
  const color = colors[i % colors.length];
  const child = spawn(p.cmd, p.args, { cwd: p.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const prefix = `${color}${p.name.padEnd(7)}\x1b[0m│ `;
  const pipe = (s: NodeJS.ReadableStream) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) process.stdout.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited with code ${code}\n`));
});

console.log(`\n  NAV is starting\n  Dashboard  http://localhost:5180\n  API        http://localhost:4000/api/v1\n  Apps       http://<service>.nav.localhost:7080\n`);

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
