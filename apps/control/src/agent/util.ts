// Agent utilities: log shipping, process spawning, port allocation, process-tree control.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { notify, pool } from '../db/pool.ts';

export const isWin = os.platform() === 'win32';

// ---------------------------------------------------------------------------------------------
// Log shipping: batches lines into multi-row INSERTs and NOTIFYs once per flush per subject.

export interface LogTarget { serviceId?: string | null; databaseId?: string | null; deployId?: string | null; instanceId?: string | null; runId?: string | null; stream: string }
interface Pending extends LogTarget { level: string; message: string; ts: Date }

const MAX_LINE = 16 * 1024;
let queue: Pending[] = [];
let flushing: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

// Strip only cursor/erase control sequences; keep SGR color codes (the dashboard renders them).
const CONTROL = /\x1b\[[0-9;?]*[ABCDEFGHJKSTfhlnsu]|\x1b\][^\x07]*\x07|\r(?!\n)/g;

export function shipLog(target: LogTarget, message: string, level = 'info'): void {
  const clean = message.replace(CONTROL, '').replace(/\s+$/, '');
  if (!clean) return;
  queue.push({ ...target, level, message: clean.length > MAX_LINE ? clean.slice(0, MAX_LINE) + ' …[truncated]' : clean, ts: new Date() });
  if (queue.length >= 500) void flushLogs();
  else if (!timer) timer = setTimeout(() => void flushLogs(), 150);
}

export async function flushLogs(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (flushing) await flushing;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  flushing = (async () => {
    try {
      const cols = 8;
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((l, i) => {
        values.push(`(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(',')})`);
        params.push(l.serviceId ?? null, l.databaseId ?? null, l.deployId ?? null, l.instanceId ?? null, l.runId ?? null, l.stream, l.level, l.message);
      });
      const res = await pool.query(
        `INSERT INTO logs (service_id, database_id, deploy_id, instance_id, run_id, stream, level, message) VALUES ${values.join(',')} RETURNING id, service_id, database_id, deploy_id, run_id`,
        params,
      );
      const seen = new Set<string>();
      for (const r of res.rows.reverse()) {
        const key = `${r.service_id}|${r.database_id}|${r.deploy_id}|${r.run_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await notify('nav_logs', { id: r.id, serviceId: r.service_id, databaseId: r.database_id, deployId: r.deploy_id, runId: r.run_id });
      }
    } catch (err) {
      console.error('[agent] log flush failed:', (err as Error).message);
    }
  })();
  await flushing;
  flushing = null;
}

/** Splits a stream into lines and ships each one. */
export function pipeLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (l: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const p of parts) onLine(p);
    if (buf.length > MAX_LINE) { onLine(buf); buf = ''; }
  });
  stream.on('end', () => { if (buf) onLine(buf); });
}

// ---------------------------------------------------------------------------------------------

/** Allocates a free TCP port on loopback (avoiding the ones we've handed out recently). */
const recentlyAllocated = new Set<number>();
export async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    if (!recentlyAllocated.has(port) && ![18012, 18013, 19099].includes(port)) {
      recentlyAllocated.add(port);
      setTimeout(() => recentlyAllocated.delete(port), 60_000).unref();
      return port;
    }
  }
  throw new Error('no free port');
}

/** Minimal environment for sandboxed commands: never inherit the platform's secrets. */
export function baseEnv(home: string): Record<string, string> {
  const pick = (k: string) => process.env[k];
  const env: Record<string, string> = { PATH: pick('PATH') ?? pick('Path') ?? '', HOME: home, LANG: 'C.UTF-8', CI: 'true' };
  if (isWin) {
    for (const k of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles']) {
      const v = pick(k);
      if (v) env[k] = v;
    }
    env.USERPROFILE = home;
    env.APPDATA = `${home}\\AppData\\Roaming`;
    env.LOCALAPPDATA = `${home}\\AppData\\Local`;
    env.TEMP = env.TMP = `${home}\\tmp`;
  } else {
    env.TMPDIR = `${home}/tmp`;
  }
  return env;
}

/** Runs a shell command, streaming output lines; resolves with the exit code. Cancellable via AbortSignal. */
export function runShell(command: string, opts: { cwd: string; env: Record<string, string>; onLine: (l: string) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnShell(command, opts.cwd, opts.env);
    pipeLines(child.stdout, opts.onLine);
    pipeLines(child.stderr, opts.onLine);
    const kill = () => killTree(child.pid, true);
    const t = opts.timeoutMs ? setTimeout(() => { opts.onLine(`==> Command timed out after ${Math.round(opts.timeoutMs! / 60000)} minutes`); kill(); }, opts.timeoutMs) : null;
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (t) clearTimeout(t);
      opts.signal?.removeEventListener('abort', kill);
      resolve(code ?? 1);
    });
  });
}

export function spawnShell(command: string, cwd: string, env: Record<string, string>): ChildProcess {
  return isWin
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
    : spawn('/bin/sh', ['-c', command], { cwd, env, detached: true });
}

/** Kills a whole process tree. On POSIX the child leads its own process group (spawned detached). */
export function killTree(pid: number | undefined, force: boolean): void {
  if (!pid) return;
  if (isWin) {
    spawn('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true }).on('error', () => {});
  } else {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits until a TCP port accepts connections, or an HTTP path answers 2xx/3xx. */
export async function healthy(host: string, port: number, path: string | null, timeoutMs = 5000): Promise<boolean> {
  if (!path) {
    return new Promise((resolve) => {
      const s = net.connect({ host, port, timeout: timeoutMs });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
      s.once('timeout', () => { s.destroy(); resolve(false); });
    });
  }
  try {
    const res = await fetch(`http://${host}:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'NAV-HealthCheck/1.0' } });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}
