// Process driver: builds in a scratch dir, keeps immutable artifacts on disk, runs instances as child process
// trees with a scrubbed environment. Intended for development and single-tenant installs — it does NOT provide
// kernel isolation (use the docker driver for untrusted code).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '@nav/shared/config';
import { publishDir } from '../detect.ts';
import { baseEnv, freePort, isWin, killTree, pipeLines, runShell, spawnShell } from '../util.ts';
import type { Artifact, BuildContext, Driver, Handle, StartSpec, Usage } from './types.ts';

const execFileP = promisify(execFile);
const dirs = {
  artifacts: path.join(config.dataDir, 'artifacts'),
  homes: path.join(config.dataDir, 'homes'),
  instances: path.join(config.dataDir, 'instances'),
  disks: path.join(config.dataDir, 'disks'),
  cache: path.join(config.dataDir, 'cache'),
};

async function sandboxHome(serviceId: string): Promise<string> {
  const home = path.join(dirs.homes, serviceId);
  await mkdir(path.join(home, 'tmp'), { recursive: true });
  if (isWin) {
    await mkdir(path.join(home, 'AppData', 'Roaming'), { recursive: true });
    await mkdir(path.join(home, 'AppData', 'Local'), { recursive: true });
  }
  return home;
}

export function processDriver(): Driver {
  return {
    name: 'process',

    async build(ctx, detected) {
      const home = await sandboxHome(ctx.serviceId);
      const cacheDir = path.join(dirs.cache, ctx.serviceId);
      if (ctx.clearCache) {
        ctx.log('==> Clearing build cache');
        await rm(cacheDir, { recursive: true, force: true });
      }
      await mkdir(cacheDir, { recursive: true });
      const env = {
        ...baseEnv(home),
        ...ctx.env,
        npm_config_cache: path.join(cacheDir, 'npm'),
        YARN_CACHE_FOLDER: path.join(cacheDir, 'yarn'),
        PIP_CACHE_DIR: path.join(cacheDir, 'pip'),
        GOCACHE: path.join(cacheDir, 'go-build'),
        GOMODCACHE: path.join(cacheDir, 'go-mod'),
        BUNDLE_PATH: path.join(ctx.appDir, 'vendor', 'bundle'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
      };
      if (detected.buildCommand) {
        ctx.log(`==> Running build command '${detected.buildCommand}'...`);
        const code = await runShell(detected.buildCommand, { cwd: ctx.appDir, env, onLine: ctx.log, signal: ctx.signal, timeoutMs: 30 * 60_000 });
        if (ctx.signal.aborted) throw new Error('build canceled');
        if (code !== 0) throw new Error(`build command exited with code ${code}`);
        ctx.log('==> Build successful 🎉');
      } else {
        ctx.log('==> No build command; skipping build step');
      }
      // Promote the checkout to an immutable artifact (rename is atomic and cheap on the same volume).
      await mkdir(dirs.artifacts, { recursive: true });
      const root = path.join(dirs.artifacts, ctx.deployId);
      await rm(path.join(ctx.srcDir, '.git'), { recursive: true, force: true });
      await rename(ctx.srcDir, root);
      const appDir = path.join(root, path.relative(ctx.srcDir, ctx.appDir));
      if (detected.runtime === 'static' || ctx.service.type === 'static') {
        const pub = await publishDir(appDir, ctx.service.publish_path);
        ctx.log(`==> Publishing ${path.relative(root, pub) || '.'}`);
        return { kind: 'dir', root, path: pub, runtime: 'static', startCommand: null };
      }
      return { kind: 'dir', root, path: appDir, runtime: detected.runtime, startCommand: detected.startCommand };
    },

    async start(spec) {
      if (spec.artifact.kind !== 'dir') throw new Error('the process driver cannot run container images; configure the docker driver');
      const command = spec.command ?? spec.artifact.startCommand;
      if (!command) throw new Error('no start command configured or detected');
      const home = await sandboxHome(spec.serviceId);
      const instDir = path.join(dirs.instances, spec.instanceId);
      const secretsDir = path.join(instDir, 'secrets');
      await mkdir(secretsDir, { recursive: true });
      for (const f of spec.files) await writeFile(path.join(secretsDir, f.filename), f.content, { mode: 0o600 });
      const port = spec.oneOff ? null : await freePort();
      const env: Record<string, string> = { ...baseEnv(home), ...spec.env, NAV_SECRETS_DIR: secretsDir };
      if (port) env.PORT = String(port);
      if (spec.disk) {
        const diskDir = path.join(dirs.disks, spec.serviceId, spec.disk.name);
        await mkdir(diskDir, { recursive: true });
        env.NAV_DISK_PATH = diskDir;
      }
      // Python virtualenvs and local bins are on PATH, like an activated shell.
      const extraPath = [path.join(spec.artifact.path, '.venv', isWin ? 'Scripts' : 'bin'), path.join(spec.artifact.path, 'node_modules', '.bin')];
      env.PATH = [...extraPath, env.PATH].join(path.delimiter);
      if (isWin) env.Path = env.PATH;
      spec.onLog(`==> Running '${command}'`);
      const child = spawnShell(command, spec.artifact.path, env);
      pipeLines(child.stdout, (l) => spec.onLog(l));
      pipeLines(child.stderr, (l) => spec.onLog(l, 'error'));
      const exited = new Promise<number>((resolve) => {
        child.on('error', (err) => { spec.onLog(`failed to start: ${err.message}`, 'error'); resolve(127); });
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      });
      exited.then(() => rm(instDir, { recursive: true, force: true }).catch(() => {}));
      return {
        ref: String(child.pid),
        host: '127.0.0.1',
        port,
        exited,
        async stop(graceMs) {
          killTree(child.pid, false);
          const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
          if (!done) killTree(child.pid, true);
          await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        },
      } satisfies Handle;
    },

    usage: sampleProcessTrees,

    async removeArtifact(artifact) {
      if (artifact.kind === 'dir' && artifact.root.startsWith(dirs.artifacts)) await rm(artifact.root, { recursive: true, force: true }).catch(() => {});
    },

    async removeServiceData(serviceId) {
      for (const d of [path.join(dirs.homes, serviceId), path.join(dirs.cache, serviceId), path.join(dirs.disks, serviceId)]) await rm(d, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// --- CPU / memory sampling of process trees ------------------------------------------------------

interface Proc { pid: number; ppid: number; cpuSec: number; mem: number }
const lastCpu = new Map<string, { t: number; cpu: number }>();

async function listProcesses(): Promise<Proc[]> {
  if (isWin) {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.KernelModeTime + $_.UserModeTime) $($_.WorkingSetSize)" }'],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
    return stdout.split(/\r?\n/).filter(Boolean).map((l) => {
      const [pid, ppid, cpu, mem] = l.trim().split(/\s+/).map(Number);
      return { pid, ppid, cpuSec: cpu / 1e7, mem };
    });
  }
  const out: Proc[] = [];
  const tick = 100;
  const pageSize = 4096;
  for (const d of await readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const stat = await readFile(`/proc/${d}/stat`, 'utf8').catch(() => null);
    if (!stat) continue;
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    out.push({ pid: Number(d), ppid: Number(f[1]), cpuSec: (Number(f[11]) + Number(f[12])) / tick, mem: Number(f[21]) * pageSize });
  }
  return out;
}

async function sampleProcessTrees(refs: string[]): Promise<Map<string, Usage>> {
  const result = new Map<string, Usage>();
  if (!refs.length) return result;
  const procs = await listProcesses().catch(() => [] as Proc[]);
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const now = Date.now();
  for (const ref of refs) {
    const root = byPid.get(Number(ref));
    if (!root) continue;
    let cpu = 0;
    let mem = 0;
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      cpu += p.cpuSec;
      mem += p.mem;
      for (const c of children.get(p.pid) ?? []) if (c.pid !== p.pid) stack.push(c);
    }
    const prev = lastCpu.get(ref);
    lastCpu.set(ref, { t: now, cpu });
    const cores = prev && now > prev.t ? Math.max(0, (cpu - prev.cpu) / ((now - prev.t) / 1000)) : 0;
    result.set(ref, { cpu: cores, memBytes: mem });
  }
  return result;
}

export async function copyDir(src: string, dst: string): Promise<void> {
  if (existsSync(src)) await cp(src, dst, { recursive: true });
}
