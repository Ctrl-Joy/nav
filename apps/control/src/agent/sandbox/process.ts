// Process sandbox driver — DEVELOPMENT ONLY, NOT ISOLATED. Each sandbox is a dedicated directory
// (<dataDir>/sandboxes/<id>/{workspace,home}); commands run as ordinary host processes with a scrubbed
// environment (no platform variables, no secrets), in their own process group (POSIX) or process tree (Windows,
// killed with taskkill /T), so a timeout or a delete kills everything a command started. There is no kernel
// isolation: code can read anything the agent's user can, use the network and exhaust host resources. The agent
// refuses to run these in production unless NAV_ALLOW_UNISOLATED_SANDBOXES=1.
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '@nav/shared/config';
import { extractInto, packDir } from '@nav/shared/artifacts';
import { SANDBOX_LIMITS, type SandboxFileEntry } from '@nav/shared';
import { baseEnv, isWin, killTree, spawnShell } from '../util.ts';
import { PathError, resolveInside, sandboxSegments } from './paths.ts';
import type { SandboxBox, SandboxDriver, SandboxProcess, SandboxSpec, StartOptions } from './types.ts';

export const sandboxesDir = () => path.join(config.dataDir, 'sandboxes');

function entryType(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): SandboxFileEntry['type'] {
  return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

/** Wraps a child process tree as a SandboxProcess. */
function wrap(child: ChildProcess, tty: boolean): SandboxProcess {
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(127));
    // 'close' (not 'exit'): every byte of output has been read by then.
    child.on('close', (code) => resolve(code));
  });
  child.stdin?.on('error', () => {}); // EPIPE when the command exits without reading its input
  return {
    tty,
    onStdout: (cb) => { child.stdout?.on('data', cb); },
    onStderr: (cb) => { child.stderr?.on('data', cb); },
    write: (d) => { if (child.stdin && !child.stdin.destroyed) child.stdin.write(d); },
    end: () => { child.stdin?.end(); },
    resize: () => {},
    async kill() {
      killTree(child.pid, true);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      // A grandchild that still holds the pipes open would keep 'close' from firing.
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    exited,
  };
}

class ProcessBox implements SandboxBox {
  id: string;
  ref: string;
  private spec: SandboxSpec;
  private workspace: string;
  private home: string;
  private procs = new Set<SandboxProcess>();

  constructor(spec: SandboxSpec, root: string) {
    this.id = spec.id;
    this.ref = root;
    this.spec = spec;
    this.workspace = path.join(root, 'workspace');
    this.home = path.join(root, 'home');
  }

  async init(): Promise<void> {
    await mkdir(this.workspace, { recursive: true });
    await mkdir(path.join(this.home, 'tmp'), { recursive: true });
    if (isWin) {
      await mkdir(path.join(this.home, 'AppData', 'Roaming'), { recursive: true });
      await mkdir(path.join(this.home, 'AppData', 'Local'), { recursive: true });
    }
  }

  async start(opts: StartOptions): Promise<SandboxProcess> {
    const cwd = await resolveInside(this.workspace, opts.cwd, 'read');
    if (!(await stat(cwd)).isDirectory()) throw new PathError('cwd is not a directory');
    // Only the host basics (PATH, locale, Windows system dirs) plus what the caller asked for.
    const env: Record<string, string> = { ...baseEnv(this.home), ...this.spec.env, ...opts.env, NAV_SANDBOX_ID: this.id, NAV_SANDBOX_WORKSPACE: this.workspace };
    let child: ChildProcess;
    if (opts.command !== null) {
      child = spawnShell(opts.command, cwd, env);
    } else {
      // No PTY without native modules: an interactive shell over pipes.
      child = isWin
        ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { cwd, env, windowsHide: true })
        : spawn('/bin/sh', ['-i'], { cwd, env: { ...env, TERM: 'dumb', PS1: '$ ' }, detached: true });
    }
    const proc = wrap(child, false);
    this.procs.add(proc);
    void proc.exited.then(() => this.procs.delete(proc));
    return proc;
  }

  async writeFile(rel: string, data: Buffer, mode = 0o644): Promise<{ size: number }> {
    if (!sandboxSegments(rel).length) throw new PathError('path names the workspace root');
    const file = await resolveInside(this.workspace, rel, 'write');
    const st = await lstat(file).catch(() => null);
    if (st?.isDirectory()) throw new PathError('path is a directory', 409);
    await writeFile(file, data, { mode: mode & 0o777 });
    if (!isWin) await chmod(file, mode & 0o777).catch(() => {});
    return { size: data.length };
  }

  async readFile(rel: string) {
    const file = await resolveInside(this.workspace, rel, 'read');
    const st = await stat(file);
    if (!st.isFile()) throw new PathError('path is not a regular file', 409);
    return { stream: createReadStream(file), size: st.size };
  }

  async list(rel: string): Promise<SandboxFileEntry[]> {
    const dir = await resolveInside(this.workspace, rel, 'read');
    if (!(await stat(dir)).isDirectory()) throw new PathError('path is not a directory', 409);
    const base = sandboxSegments(rel).join('/');
    const out: SandboxFileEntry[] = [];
    for (const ent of (await readdir(dir, { withFileTypes: true })).slice(0, SANDBOX_LIMITS.maxListEntries)) {
      const st = await lstat(path.join(dir, ent.name)).catch(() => null);
      if (!st) continue;
      out.push({ name: ent.name, path: base ? `${base}/${ent.name}` : ent.name, type: entryType(st), size: st.isFile() ? st.size : 0, modifiedAt: st.mtime.toISOString() });
    }
    return out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  }

  async remove(rel: string, recursive: boolean): Promise<void> {
    if (!sandboxSegments(rel).length) throw new PathError('refusing to delete the workspace root');
    const target = await resolveInside(this.workspace, rel, 'delete');
    const st = await lstat(target);
    if (st.isDirectory() && !recursive) {
      await rmdir(target).catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'ENOTEMPTY' || err.code === 'EEXIST' ? new PathError('directory is not empty (pass recursive=1)', 409) : err;
      });
      return;
    }
    // A symlink is unlinked, never followed (rm does not follow links).
    await rm(target, { recursive: st.isDirectory(), force: true });
  }

  async archive() {
    return packDir(this.workspace);
  }

  async restore(tar: import('node:stream').Readable): Promise<void> {
    await extractInto(tar, this.workspace);
  }

  async destroy(): Promise<void> {
    await Promise.all([...this.procs].map((p) => p.kill()));
    // Windows can hold a handle briefly after the tree dies.
    for (let i = 0; i < 5; i++) {
      try {
        await rm(this.ref, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
  }
}

export function processSandboxDriver(): SandboxDriver {
  return {
    name: 'process',
    isolated: false,
    async create(spec) {
      if (!/^[a-z0-9_]+$/.test(spec.id)) throw new Error('invalid sandbox id');
      const root = path.join(sandboxesDir(), spec.id);
      await rm(root, { recursive: true, force: true });
      const box = new ProcessBox(spec, root);
      await box.init();
      return box;
    },
    async sweep(keep) {
      const dir = sandboxesDir();
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!keep.has(name)) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
