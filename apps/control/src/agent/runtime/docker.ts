// Docker driver: immutable images per deploy, hardened containers, per-workspace bridge networks.
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import { config } from '@nav/shared/config';
import { pipeLines } from '../util.ts';
import type { Artifact, BuildContext, Driver, Handle, StartSpec, Usage } from './types.ts';

export const DEFAULT_CONTAINER_PORT = 10000;

const BASE_IMAGES: Record<string, string> = {
  node: 'node:22-bookworm-slim',
  bun: 'oven/bun:1',
  python: 'python:3.13-slim',
  go: 'golang:1.25-bookworm',
  ruby: 'ruby:3.4-slim',
  static: 'nginx:alpine', // only used for the build stage; static sites are served by the edge
};

export async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return JSON.stringify(['/bin/sh', '-c', s]);
}

/** Generates a Dockerfile for native runtimes. Env vars are available at build time as ARGs. */
export function nativeDockerfile(runtime: string, build: string | null, start: string | null, envKeys: string[]): string {
  const base = BASE_IMAGES[runtime] ?? BASE_IMAGES.node;
  const args = envKeys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map((k) => `ARG ${k}`).join('\n');
  const lines = [
    `FROM ${base}`,
    'WORKDIR /app',
    args,
    'COPY . .',
    runtime === 'python' ? 'RUN python -m venv /app/.venv' : '',
    runtime === 'python' ? 'ENV PATH=/app/.venv/bin:$PATH' : '',
    build ? `RUN ${build.replace(/\.venv\/bin\//g, '')}` : '',
    'ENV PORT=10000 NODE_ENV=production',
    // Run as an unprivileged user when the base image has one.
    runtime === 'node' ? 'RUN chown -R node:node /app\nUSER node' : 'RUN useradd -r -u 10001 app 2>/dev/null || adduser -D -u 10001 app 2>/dev/null || true\nRUN chown -R 10001 /app\nUSER 10001',
    start ? `CMD ${shellQuote(start)}` : '',
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}

async function* walk(dir: string, rel = ''): AsyncGenerator<string> {
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel.split(path.sep).join('/'), e.name);
    if (e.name === '.git' || e.name === 'node_modules' && rel === '') continue;
    if (e.isDirectory()) yield* walk(dir, path.join(rel, e.name));
    else if (e.isFile()) yield r;
  }
}

/** Packs a build context into a tar stream, honoring simple .dockerignore patterns. */
async function contextTar(dir: string, extra: Record<string, string>): Promise<Readable> {
  const pack = tar.pack();
  const ignore: RegExp[] = [];
  const di = path.join(dir, '.dockerignore');
  if (existsSync(di)) {
    for (const line of (await readFile(di, 'utf8')).split(/\r?\n/)) {
      const p = line.trim();
      if (!p || p.startsWith('#') || p.startsWith('!')) continue;
      ignore.push(new RegExp('^' + p.replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '(/.*)?$'));
    }
  }
  (async () => {
    for await (const rel of walk(dir)) {
      if (ignore.some((r) => r.test(rel))) continue;
      const full = path.join(dir, rel);
      const st = await stat(full);
      pack.entry({ name: rel, size: st.size, mode: st.mode & 0o777 }, await readFile(full));
    }
    for (const [name, content] of Object.entries(extra)) pack.entry({ name }, content);
    pack.finalize();
  })().catch((err) => pack.destroy(err));
  return pack as unknown as Readable;
}

async function followProgress(docker: Docker, stream: NodeJS.ReadableStream, log: (l: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null, res: any[]) => {
      if (err) return reject(err);
      const failed = res.find((r) => r.error);
      if (failed) return reject(new Error(failed.error));
      resolve();
    }, (ev: any) => {
      if (ev.stream) for (const l of String(ev.stream).split('\n')) if (l.trim()) log(l);
      if (ev.status && !ev.progressDetail?.current) log(`${ev.id ? ev.id + ': ' : ''}${ev.status}`);
      if (ev.error) log(ev.error);
    });
  });
}

/** Static sites build inside a container; the publish directory is then copied out for the edge to serve. */
async function extractStatic(docker: Docker, tag: string, ctx: BuildContext, publishPath: string | null): Promise<Artifact> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { config } = await import('@nav/shared/config');
  const container = await docker.createContainer({ Image: tag, Cmd: ['true'], Labels: { 'nav.tmp': '1' } });
  try {
    const candidates = publishPath ? [publishPath] : ['dist', 'build', 'out', 'public', '_site', '.'];
    for (const c of candidates) {
      const src = path.posix.join('/app', c);
      const archive = await container.getArchive({ path: src }).catch(() => null);
      if (!archive) continue;
      const root = path.join(config.dataDir, 'artifacts', ctx.deployId);
      const base = path.posix.basename(src);
      await new Promise<void>((resolve, reject) => {
        const ex = tar.extract();
        ex.on('entry', (h, stream, next) => {
          const rel = h.name.split('/').slice(1).join('/');
          const dest = path.resolve(root, rel);
          if (!rel || !dest.startsWith(root) || h.type !== 'file') { stream.resume(); stream.on('end', next); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (d) => chunks.push(d as Buffer));
          stream.on('end', () => { mkdir(path.dirname(dest), { recursive: true }).then(() => writeFile(dest, Buffer.concat(chunks))).then(() => next(), reject); });
        });
        ex.on('finish', resolve);
        ex.on('error', reject);
        archive.pipe(ex);
      });
      if (!existsSync(path.join(root, 'index.html')) && !publishPath) continue;
      ctx.log(`==> Publishing ${base}`);
      return { kind: 'dir', root, path: root, runtime: 'static', startCommand: null };
    }
    throw new Error('could not find a publish directory in the build output; set the publish path');
  } finally {
    await container.remove({ force: true }).catch(() => {});
    await docker.getImage(tag).remove({ force: true }).catch(() => {});
  }
}

export function dockerDriver(): Driver {
  const docker = new Docker();

  async function ensureNetwork(workspaceId: string): Promise<string> {
    const name = `nav-${workspaceId}`;
    const nets = await docker.listNetworks({ filters: { name: [name] } });
    if (!nets.some((n) => n.Name === name)) await docker.createNetwork({ Name: name, Driver: 'bridge', Labels: { 'nav.workspace': workspaceId } }).catch(() => {});
    return name;
  }

  function attachLogs(container: Docker.Container, onLog: StartSpec['onLog']): void {
    container.logs({ follow: true, stdout: true, stderr: true, since: Math.floor(Date.now() / 1000) - 1 }, (err, stream) => {
      if (err || !stream) return;
      const out = new PassThrough();
      const errs = new PassThrough();
      docker.modem.demuxStream(stream, out, errs);
      pipeLines(out, (l) => onLog(l));
      pipeLines(errs, (l) => onLog(l, 'error'));
    });
  }

  function handleFor(container: Docker.Container, ref: string, port: number | null): Handle {
    const exited = container.wait().then((r: { StatusCode: number }) => r.StatusCode).catch(() => 1);
    return {
      ref,
      host: config.nodeAddress,
      port,
      exited,
      async stop(graceMs) {
        await container.stop({ t: Math.ceil(graceMs / 1000) }).catch(() => {});
        await container.remove({ force: true, v: false }).catch(() => {});
      },
    };
  }

  return {
    name: 'docker',

    async build(ctx, detected) {
      const tag = `nav/${ctx.serviceId}:${ctx.deployId}`.toLowerCase();
      const svc = ctx.service;
      let dockerfile = svc.dockerfile_path || 'Dockerfile';
      let contextDir = path.resolve(ctx.appDir, svc.docker_context || '.');
      if (!contextDir.startsWith(ctx.srcDir)) throw new Error('docker context must be inside the repository');
      const extra: Record<string, string> = {};
      if (detected.runtime !== 'docker') {
        contextDir = ctx.appDir;
        dockerfile = '.nav.Dockerfile';
        extra[dockerfile] = nativeDockerfile(detected.runtime, detected.buildCommand, detected.startCommand, Object.keys(ctx.env));
        ctx.log(`==> Generated Dockerfile for the ${detected.runtime} runtime`);
      } else if (!existsSync(path.resolve(ctx.appDir, dockerfile))) {
        throw new Error(`Dockerfile not found at ${dockerfile}`);
      } else {
        dockerfile = path.relative(contextDir, path.resolve(ctx.appDir, dockerfile)).split(path.sep).join('/');
      }
      ctx.log(`==> Building image ${tag}`);
      const stream = await docker.buildImage(await contextTar(contextDir, extra) as unknown as NodeJS.ReadableStream, {
        t: tag,
        dockerfile,
        buildargs: detected.runtime !== 'docker' ? ctx.env : Object.fromEntries(Object.entries(ctx.env).filter(([k]) => k.startsWith('NAV_'))),
        nocache: ctx.clearCache,
        forcerm: true,
        labels: { 'nav.service': ctx.serviceId, 'nav.deploy': ctx.deployId },
        abortSignal: ctx.signal,
      } as Docker.ImageBuildOptions);
      await followProgress(docker, stream, ctx.log);
      ctx.log('==> Image built 🎉');
      if (svc.type === 'static') return extractStatic(docker, tag, ctx, svc.publish_path);
      return { kind: 'image', ref: tag, startCommand: detected.runtime === 'docker' ? svc.start_command : null };
    },

    async pullImage(imageUrl, log) {
      log(`==> Pulling image ${imageUrl}`);
      const stream = await docker.pull(imageUrl);
      await followProgress(docker, stream, log);
      return { kind: 'image', ref: imageUrl, startCommand: null };
    },

    async start(spec) {
      if (spec.artifact.kind !== 'image') throw new Error('docker driver expects an image artifact');
      const network = await ensureNetwork(spec.workspaceId);
      const containerPort = spec.containerPort ?? DEFAULT_CONTAINER_PORT;
      const env = { ...spec.env, ...(spec.oneOff ? {} : { PORT: String(containerPort) }) };
      const command = spec.command ?? spec.artifact.startCommand;
      const mounts: Docker.MountSettings[] = spec.disk ? [{ Type: 'volume', Source: `nav-disk-${spec.serviceId}-${spec.disk.name}`, Target: spec.disk.mountPath }] : [];
      const container = await docker.createContainer({
        name: `nav-${spec.instanceId}`,
        Image: spec.artifact.ref,
        Cmd: command ? ['/bin/sh', '-c', command] : undefined,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: { 'nav.instance': spec.instanceId, 'nav.service': spec.serviceId, 'nav.workspace': spec.workspaceId },
        ExposedPorts: spec.oneOff ? undefined : { [`${containerPort}/tcp`]: {} },
        HostConfig: {
          NetworkMode: network,
          PortBindings: spec.oneOff ? undefined : { [`${containerPort}/tcp`]: [{ HostIp: config.nodeBindIp, HostPort: '' }] },
          Memory: spec.plan.memoryMB * 1024 * 1024,
          MemorySwap: spec.plan.memoryMB * 1024 * 1024,
          NanoCpus: Math.round(spec.plan.cpu * 1e9),
          PidsLimit: 512,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE', 'DAC_OVERRIDE', 'FOWNER'],
          SecurityOpt: ['no-new-privileges:true'],
          Mounts: mounts,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
          Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: spec.oneOff ? [] : [spec.slug] } } },
      });
      if (spec.files.length) {
        const pack = tar.pack();
        for (const f of spec.files) pack.entry({ name: `etc/secrets/${f.filename}`, mode: 0o444 }, f.content);
        pack.finalize();
        await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: '/' });
      }
      await container.start();
      attachLogs(container, spec.onLog);
      let port: number | null = null;
      if (!spec.oneOff) {
        const info = await container.inspect();
        port = Number(info.NetworkSettings.Ports[`${containerPort}/tcp`]?.[0]?.HostPort) || null;
      }
      return handleFor(container, container.id, port);
    },

    async adopt(ref, onLog) {
      const container = docker.getContainer(ref);
      const info = await container.inspect().catch(() => null);
      if (!info?.State.Running) return null;
      attachLogs(container, onLog);
      const binding = Object.values(info.NetworkSettings.Ports ?? {})[0]?.[0];
      return handleFor(container, ref, binding ? Number(binding.HostPort) : null);
    },

    async usage(refs) {
      const out = new Map<string, Usage>();
      await Promise.all(refs.map(async (ref) => {
        const s = await docker.getContainer(ref).stats({ stream: false }).catch(() => null) as any;
        if (!s) return;
        const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
        const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
        const cores = s.cpu_stats.online_cpus ?? 1;
        out.set(ref, { cpu: sysDelta > 0 ? (cpuDelta / sysDelta) * cores : 0, memBytes: (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? 0) });
      }));
      return out;
    },

    async removeArtifact(artifact: Artifact) {
      if (artifact.kind === 'image' && artifact.ref.startsWith('nav/')) await docker.getImage(artifact.ref).remove({ force: true }).catch(() => {});
    },

    async hasImage(ref) {
      return Boolean(await docker.getImage(ref).inspect().catch(() => null));
    },

    async saveImage(ref) {
      return docker.getImage(ref).get();
    },

    async loadImage(stream) {
      const out = await docker.loadImage(stream);
      await followProgress(docker, out, () => {});
    },

    async removeServiceData(serviceId) {
      const vols = await docker.listVolumes({ filters: { name: [`nav-disk-${serviceId}-`] } }).catch(() => null);
      for (const v of vols?.Volumes ?? []) await docker.getVolume(v.Name).remove().catch(() => {});
    },
  };
}
