// Docker sandbox driver: one locked-down container per sandbox. No capabilities, no-new-privileges, a read-only
// root filesystem with a writable /workspace volume (plus small tmpfs mounts for /tmp and $HOME), memory / CPU /
// pids limits from the plan, and no network unless egress was asked for (then a dedicated bridge where sandboxes
// cannot reach each other). File operations go through the Engine's archive API, which resolves paths inside the
// container's own root, after a confinement check that keeps them under /workspace.
import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import type { SandboxFileEntry } from '@nav/shared';
import { SANDBOX_LIMITS } from '@nav/shared';
import { PathError, WORKSPACE_MOUNT, containerPath, sandboxSegments } from './paths.ts';
import type { SandboxBox, SandboxDriver, SandboxProcess, SandboxSpec, StartOptions } from './types.ts';

export const SANDBOX_EGRESS_NETWORK = 'nav-sandbox-egress';
export const SANDBOX_HOME = '/home/sandbox';
const EXEC_DIR = '/tmp/.nav-exec';

export const containerName = (id: string) => `nav-sbx-${id}`;
export const volumeName = (id: string) => `nav-sbx-${id}`;

/** The container a sandbox runs in. Pure, so the lock-down can be unit tested without a Docker Engine. */
export function sandboxContainerSpec(spec: SandboxSpec): Docker.ContainerCreateOptions {
  const env = { ...spec.env, HOME: SANDBOX_HOME, NAV_SANDBOX_ID: spec.id };
  return {
    name: containerName(spec.id),
    Image: spec.image,
    // Idle keeper process; commands arrive through exec. Overrides the image's entrypoint and command.
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: ['while :; do sleep 3600; done'],
    WorkingDir: WORKSPACE_MOUNT,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { 'nav.sandbox': spec.id, 'nav.workspace': spec.workspaceId },
    NetworkDisabled: spec.networkAccess === 'none',
    HostConfig: {
      NetworkMode: spec.networkAccess === 'none' ? 'none' : SANDBOX_EGRESS_NETWORK,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Init: true,
      Memory: spec.plan.memoryMB * 1024 * 1024,
      MemorySwap: spec.plan.memoryMB * 1024 * 1024,
      NanoCpus: Math.round(spec.plan.cpu * 1e9),
      PidsLimit: spec.plan.pids,
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      Mounts: [{ Type: 'volume', Source: volumeName(spec.id), Target: WORKSPACE_MOUNT }],
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=256m',
        [SANDBOX_HOME]: 'rw,nosuid,nodev,size=256m',
      },
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no' },
      PortBindings: {},
      PublishAllPorts: false,
      IpcMode: 'private',
    },
  };
}

/** The egress network: a plain bridge with inter-container traffic disabled. */
export function egressNetworkSpec(): Docker.NetworkCreateOptions {
  return {
    Name: SANDBOX_EGRESS_NETWORK,
    Driver: 'bridge',
    Internal: false,
    Labels: { 'nav.sandbox-network': '1' },
    Options: { 'com.docker.network.bridge.enable_icc': 'false' },
  };
}

const SHELL = 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi';

/**
 * The exec command line: records its PID (so the whole tree can be killed later), enters the working directory
 * and replaces itself with the user's command. A null command opens a login shell.
 */
export function execCommand(execId: string, cwd: string, command: string | null): string[] {
  return ['/bin/sh', '-c', `mkdir -p ${EXEC_DIR} && echo $$ > "${EXEC_DIR}/$1" && cd -- "$2" && exec /bin/sh -c "$3"`, 'nav-exec', execId, cwd, command ?? SHELL];
}

/** Kills an exec and all its descendants, found through /proc (slim images have no ps or pkill). */
export function killCommand(execId: string): string[] {
  const script = [
    `p=$(cat "${EXEC_DIR}/$1" 2>/dev/null) || exit 0`,
    // /proc/<pid>/stat: "pid (comm) state ppid ...". Children first, so nothing is reparented away mid-walk.
    'kt() { for s in /proc/[0-9]*/stat; do read -r _ _ _ pp _ < "$s" 2>/dev/null || continue; if [ "$pp" = "$1" ]; then c=${s#/proc/}; kt "${c%/stat}"; fi; done; kill -KILL "$1" 2>/dev/null; }',
    'kt "$p"',
    `rm -f "${EXEC_DIR}/$1"`,
  ].join('\n');
  return ['/bin/sh', '-c', script, 'nav-kill', execId];
}

/**
 * Resolves a /workspace path inside the container and prints the real path; exit 2 = missing, 3 = unusable,
 * 4 = it escapes /workspace. 'write' creates missing parents (after checking the deepest existing one).
 */
export function confineCommand(p: string, mode: 'read' | 'write' | 'delete'): string[] {
  const script = `
p=$1; mode=$2
inside() { case "$1/" in ${WORKSPACE_MOUNT}/*) return 0;; *) return 1;; esac; }
d=$(dirname -- "$p")
if [ "$mode" = write ]; then
  a=$d; while [ ! -d "$a" ]; do a=$(dirname -- "$a"); done
  a=$(cd -P -- "$a" 2>/dev/null && pwd -P) || exit 3
  inside "$a" || exit 4
  mkdir -p -- "$d" 2>/dev/null || exit 3
fi
r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || exit 2
inside "$r" || exit 4
t="$r/$(basename -- "$p")"
if [ "$mode" != write ]; then [ -e "$t" ] || [ -L "$t" ] || exit 2; fi
if [ "$mode" != delete ] && [ -L "$t" ]; then t=$(readlink -f -- "$t") || exit 2; fi
inside "$t" || exit 4
printf '%s' "$t"`;
  return ['/bin/sh', '-c', script, 'nav-confine', p, mode];
}

/** Lists a directory as NUL-separated "type<TAB>size<TAB>mtime<TAB>name" records. */
export function listCommand(dir: string): string[] {
  const script = `cd -P -- "$1" 2>/dev/null || exit 2
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then t=symlink; elif [ -d "$f" ]; then t=dir; elif [ -f "$f" ]; then t=file; else t=other; fi
  m=$(stat -c '%s %Y' -- "$f" 2>/dev/null || echo '0 0')
  printf '%s\\t%s\\t%s\\t%s\\0' "$t" "\${m% *}" "\${m#* }" "$f"
done`;
  return ['/bin/sh', '-c', script, 'nav-ls', dir];
}

export function parseListing(raw: string, base: string[]): SandboxFileEntry[] {
  const out: SandboxFileEntry[] = [];
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const [type, size, mtime, ...rest] = rec.split('\t');
    const name = rest.join('\t');
    if (!name) continue;
    out.push({
      name,
      path: [...base, name].join('/'),
      type: (['file', 'dir', 'symlink'].includes(type) ? type : 'other') as SandboxFileEntry['type'],
      size: type === 'file' ? Number(size) || 0 : 0,
      modifiedAt: new Date((Number(mtime) || 0) * 1000).toISOString(),
    });
    if (out.length >= SANDBOX_LIMITS.maxListEntries) break;
  }
  return out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
}

/**
 * Re-tars a `docker cp` archive of a directory so entries are relative to it: `workspace/a.txt` -> `a.txt`.
 * The directory's own entry is dropped, and so is anything outside it.
 */
export function stripTarPrefix(src: Readable, prefix: string): Readable {
  const ex = tar.extract();
  const pack = tar.pack();
  const strip = `${prefix.replace(/^\/+|\/+$/g, '')}/`;
  ex.on('entry', (header, stream, next) => {
    const name = header.name.replace(/^\.\//, '');
    if (!name.startsWith(strip) || name.length === strip.length) {
      stream.on('end', next);
      stream.resume();
      return;
    }
    const entry = pack.entry({ ...header, name: name.slice(strip.length) }, (err) => next(err ?? undefined));
    stream.pipe(entry);
  });
  ex.on('finish', () => pack.finalize());
  ex.on('error', (err) => pack.destroy(err));
  src.on('error', (err) => ex.destroy(err));
  src.pipe(ex);
  return pack as unknown as Readable;
}

async function followProgress(docker: Docker, stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null, res: { error?: string }[]) => {
      if (err) return reject(err);
      const failed = res.find((r) => r.error);
      return failed ? reject(new Error(failed.error)) : resolve();
    });
  });
}

/** Runs a helper command in the container and collects its output. */
async function run(docker: Docker, container: Docker.Container, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  const o: Buffer[] = [];
  const e: Buffer[] = [];
  out.on('data', (d: Buffer) => o.push(d));
  err.on('data', (d: Buffer) => e.push(d));
  docker.modem.demuxStream(stream, out, err);
  await new Promise<void>((resolve) => { stream.on('end', resolve); stream.on('close', resolve); stream.on('error', () => resolve()); });
  const info = await exec.inspect();
  return { code: info.ExitCode ?? 1, stdout: Buffer.concat(o).toString('utf8'), stderr: Buffer.concat(e).toString('utf8') };
}

class DockerBox implements SandboxBox {
  id: string;
  ref: string;
  private docker: Docker;
  private container: Docker.Container;
  private procs = new Set<SandboxProcess>();

  constructor(docker: Docker, id: string, ref: string) {
    this.docker = docker;
    this.id = id;
    this.ref = ref;
    this.container = docker.getContainer(ref);
  }

  private async confine(rel: string, mode: 'read' | 'write' | 'delete'): Promise<string> {
    const p = containerPath(rel);
    if (p === WORKSPACE_MOUNT) return p;
    const r = await run(this.docker, this.container, confineCommand(p, mode));
    if (r.code === 2) throw new PathError('no such file or directory', 404);
    if (r.code === 4) throw new PathError('path escapes the sandbox', 403);
    const real = r.stdout;
    if (r.code !== 0 || !(real === WORKSPACE_MOUNT || real.startsWith(`${WORKSPACE_MOUNT}/`))) throw new PathError('path cannot be used');
    return real;
  }

  async start(opts: StartOptions): Promise<SandboxProcess> {
    const cwd = await this.confine(opts.cwd, 'read');
    const execId = randomBytes(8).toString('hex');
    const exec = await this.container.exec({
      Cmd: execCommand(execId, cwd, opts.command),
      Env: [...Object.entries(opts.env).map(([k, v]) => `${k}=${v}`), ...(opts.tty ? ['TERM=xterm-256color', `COLUMNS=${opts.cols}`, `LINES=${opts.rows}`] : [])],
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: opts.tty,
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: opts.tty } as Docker.ExecStartOptions) as unknown as import('node:stream').Duplex;
    if (opts.tty) await exec.resize({ h: opts.rows, w: opts.cols }).catch(() => {});
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    if (opts.tty) stream.pipe(stdout);
    else this.docker.modem.demuxStream(stream, stdout, stderr);
    const exited = new Promise<number | null>((resolve) => {
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        stdout.end();
        stderr.end();
        resolve((await exec.inspect().catch(() => null))?.ExitCode ?? null);
      };
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
    });
    const proc: SandboxProcess = {
      tty: opts.tty,
      onStdout: (cb) => { stdout.on('data', cb); },
      onStderr: (cb) => { stderr.on('data', cb); },
      write: (d) => { if (!stream.destroyed) stream.write(d); },
      // Half-close: the command sees EOF on stdin, output keeps flowing.
      end: () => { (stream as unknown as { end(): void }).end(); },
      resize: (cols, rows) => { if (opts.tty) void exec.resize({ h: rows, w: cols }).catch(() => {}); },
      kill: async () => {
        await run(this.docker, this.container, killCommand(execId)).catch(() => {});
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        stream.destroy();
      },
      exited,
    };
    this.procs.add(proc);
    void exited.then(() => this.procs.delete(proc));
    return proc;
  }

  async writeFile(rel: string, data: Buffer, mode = 0o644): Promise<{ size: number }> {
    const segs = sandboxSegments(rel);
    if (!segs.length) throw new PathError('path names the workspace root');
    const real = await this.confine(rel, 'write');
    const dir = real.slice(0, real.lastIndexOf('/')) || '/';
    const pack = tar.pack();
    pack.entry({ name: real.slice(real.lastIndexOf('/') + 1), mode: mode & 0o777, size: data.length }, data);
    pack.finalize();
    await this.container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: dir });
    return { size: data.length };
  }

  async readFile(rel: string): Promise<{ stream: Readable; size: number }> {
    const real = await this.confine(rel, 'read');
    const archive = (await this.container.getArchive({ path: real })) as unknown as Readable;
    return new Promise((resolve, reject) => {
      const ex = tar.extract();
      let found = false;
      ex.on('entry', (header, stream, next) => {
        if (found) { stream.on('end', next); stream.resume(); return; }
        found = true;
        if (header.type !== 'file') {
          stream.resume();
          reject(new PathError('path is not a regular file', 409));
          ex.destroy();
          return;
        }
        const out = new PassThrough();
        stream.pipe(out);
        stream.on('end', next);
        resolve({ stream: out, size: header.size ?? 0 });
      });
      ex.on('finish', () => { if (!found) reject(new PathError('no such file or directory', 404)); });
      ex.on('error', reject);
      archive.on('error', reject);
      archive.pipe(ex);
    });
  }

  async list(rel: string): Promise<SandboxFileEntry[]> {
    const real = await this.confine(rel, 'read');
    const r = await run(this.docker, this.container, listCommand(real));
    if (r.code === 2) throw new PathError('path is not a directory', 409);
    return parseListing(r.stdout, sandboxSegments(rel));
  }

  async remove(rel: string, recursive: boolean): Promise<void> {
    if (!sandboxSegments(rel).length) throw new PathError('refusing to delete the workspace root');
    const real = await this.confine(rel, 'delete');
    const r = await run(this.docker, this.container, recursive ? ['rm', '-rf', '--', real] : ['/bin/sh', '-c', 'if [ -d "$1" ] && [ ! -L "$1" ]; then rmdir -- "$1"; else rm -f -- "$1"; fi', 'nav-rm', real]);
    if (r.code !== 0) throw new PathError(recursive ? r.stderr.trim() || 'could not delete' : 'directory is not empty (pass recursive=1)', 409);
  }

  async archive(): Promise<Readable> {
    return stripTarPrefix((await this.container.getArchive({ path: WORKSPACE_MOUNT })) as unknown as Readable, WORKSPACE_MOUNT.slice(1));
  }

  async restore(src: Readable): Promise<void> {
    await this.container.putArchive(src as unknown as NodeJS.ReadableStream, { path: WORKSPACE_MOUNT });
  }

  async destroy(): Promise<void> {
    await Promise.all([...this.procs].map((p) => p.kill().catch(() => {})));
    await this.container.remove({ force: true, v: true }).catch(() => {});
    await this.docker.getVolume(volumeName(this.id)).remove().catch(() => {});
  }
}

export function dockerSandboxDriver(docker = new Docker()): SandboxDriver {
  async function ensureImage(image: string): Promise<void> {
    if (await docker.getImage(image).inspect().catch(() => null)) return;
    await followProgress(docker, await docker.pull(image));
  }

  async function ensureEgressNetwork(): Promise<void> {
    const nets = await docker.listNetworks({ filters: { name: [SANDBOX_EGRESS_NETWORK] } });
    if (!nets.some((n) => n.Name === SANDBOX_EGRESS_NETWORK)) await docker.createNetwork(egressNetworkSpec()).catch(() => {});
  }

  return {
    name: 'docker',
    isolated: true,
    async create(spec) {
      await ensureImage(spec.image);
      if (spec.networkAccess === 'egress') await ensureEgressNetwork();
      await docker.getContainer(containerName(spec.id)).remove({ force: true, v: true }).catch(() => {});
      const container = await docker.createContainer(sandboxContainerSpec(spec));
      try {
        await container.start();
      } catch (err) {
        await container.remove({ force: true, v: true }).catch(() => {});
        throw err;
      }
      return new DockerBox(docker, spec.id, container.id);
    },
    async adopt(id) {
      const info = await docker.getContainer(containerName(id)).inspect().catch(() => null);
      return info?.State.Running ? new DockerBox(docker, id, info.Id) : null;
    },
    async sweep(keep) {
      const containers = await docker.listContainers({ all: true, filters: { label: ['nav.sandbox'] } }).catch(() => []);
      for (const c of containers) {
        const id = c.Labels['nav.sandbox'];
        if (keep.has(id)) continue;
        await docker.getContainer(c.Id).remove({ force: true, v: true }).catch(() => {});
        await docker.getVolume(volumeName(id)).remove().catch(() => {});
      }
    },
  };
}
