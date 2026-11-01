// Artifact store client shared by agents and the edge. Builds move between nodes as gzipped tarballs held by the
// control plane, addressed by key and verified against the SHA-256 recorded when they were uploaded.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import tar from 'tar-stream';
import { config } from './config.ts';

export interface StoredArtifact { key: string; digest: string; size: number }

export const ARTIFACT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Bearer token for the control plane's internal API, derived from the master key every node already holds. */
export function nodeToken(): string {
  const key = process.env.NAV_MASTER_KEY;
  if (!key) throw new Error('NAV_MASTER_KEY must be set');
  return createHmac('sha256', key).update('nav:internal-api:v1').digest('base64url');
}

/** A relative link target that stays inside the tree when resolved from the link's own directory. */
function safeLink(name: string, target: string): boolean {
  if (!target || path.isAbsolute(target) || path.win32.isAbsolute(target) || target.includes('\0')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target.split('\\').join('/')));
  return resolved !== '..' && !resolved.startsWith('../') && !resolved.startsWith('/');
}

/** Streams a directory as a tar of regular files, directories and in-tree relative symlinks. */
export function packDir(root: string): Readable {
  const pack = tar.pack();
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const name = path.relative(root, abs).split(path.sep).join('/');
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        const target = await readlink(abs);
        if (safeLink(name, target)) pack.entry({ name, type: 'symlink', linkname: target.split('\\').join('/') });
      } else if (st.isDirectory()) {
        pack.entry({ name, type: 'directory', mode: (st.mode & 0o777) | 0o700, mtime: st.mtime });
        await walk(abs);
      } else if (st.isFile()) {
        await new Promise<void>((resolve, reject) => {
          const entry = pack.entry({ name, size: st.size, mode: (st.mode & 0o777) | 0o600, mtime: st.mtime }, (err) => (err ? reject(err) : resolve()));
          createReadStream(abs).on('error', reject).pipe(entry);
        });
      }
    }
  };
  walk(root).then(() => pack.finalize(), (err) => pack.destroy(err));
  return pack as unknown as Readable;
}

/**
 * Extracts a tar into `dest`. Entries can never land outside it: absolute names and `..` segments are refused,
 * and symlinks are created only after every file is written, so no write can pass through one.
 */
export async function extractInto(src: Readable, dest: string): Promise<void> {
  const root = path.resolve(dest);
  await mkdir(root, { recursive: true });
  const links: { at: string; target: string }[] = [];
  const ex = tar.extract();
  src.on('error', (err) => ex.destroy(err));
  src.pipe(ex);
  for await (const entry of ex) {
    const name = entry.header.name.split('\\').join('/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const parts = name.split('/');
    const unsafe = !name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\0') || parts.some((p) => p === '..' || p === '');
    const at = path.resolve(root, ...parts);
    if (unsafe || !at.startsWith(root + path.sep)) { entry.resume(); continue; }
    const type = entry.header.type;
    if (type === 'directory') {
      await mkdir(at, { recursive: true });
      entry.resume();
    } else if (type === 'file') {
      await mkdir(path.dirname(at), { recursive: true });
      await pipeline(entry, createWriteStream(at, { mode: (entry.header.mode ?? 0o644) & 0o777 }));
    } else {
      if (type === 'symlink' && entry.header.linkname && safeLink(name, entry.header.linkname)) links.push({ at, target: entry.header.linkname });
      entry.resume();
    }
  }
  for (const l of links) {
    if (existsSync(l.at)) continue;
    await mkdir(path.dirname(l.at), { recursive: true });
    await symlink(l.target, l.at).catch(() => {}); // Windows without symlink rights: the link is dropped
  }
}

function hashing(): { stream: Transform; result: () => { digest: string; size: number } } {
  const h = createHash('sha256');
  let size = 0;
  const stream = new Transform({ transform(chunk, _enc, cb) { h.update(chunk); size += chunk.length; cb(null, chunk); } });
  return { stream, result: () => ({ digest: h.digest('hex'), size }) };
}

/** Uploads a stream (already gzipped) under `key`; the control plane answers with its digest and size. */
export async function uploadArtifact(key: string, body: Readable): Promise<StoredArtifact> {
  if (!ARTIFACT_KEY.test(key)) throw new Error(`invalid artifact key ${key}`);
  const res = await fetch(`${config.controlUrl}/internal/v1/artifacts/${key}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${nodeToken()}`, 'content-type': 'application/octet-stream' },
    body: Readable.toWeb(body) as ReadableStream,
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) throw new Error(`artifact upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as StoredArtifact;
}

/** Downloads a stored artifact to `file`, refusing it unless the bytes match the recorded digest. */
export async function downloadArtifact(stored: StoredArtifact, file: string): Promise<void> {
  const res = await fetch(`${config.controlUrl}/internal/v1/artifacts/${stored.key}`, { headers: { authorization: `Bearer ${nodeToken()}` } });
  if (!res.ok || !res.body) throw new Error(`artifact ${stored.key} is not available from the store (${res.status})`);
  await mkdir(path.dirname(file), { recursive: true });
  const h = hashing();
  try {
    await pipeline(Readable.fromWeb(res.body as never), h.stream, createWriteStream(file));
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
  const got = h.result();
  if (got.digest !== stored.digest || got.size !== stored.size) {
    await rm(file, { force: true });
    throw new Error(`artifact ${stored.key} failed its integrity check`);
  }
}

export async function deleteStoredArtifact(key: string): Promise<void> {
  if (!ARTIFACT_KEY.test(key)) return;
  await fetch(`${config.controlUrl}/internal/v1/artifacts/${key}`, { method: 'DELETE', headers: { authorization: `Bearer ${nodeToken()}` } }).catch(() => {});
}

/** Packs and uploads a directory artifact. */
export async function publishDir(key: string, root: string): Promise<StoredArtifact> {
  return uploadArtifact(key, packDir(root).pipe(createGzip({ level: 6 })));
}

const inflight = new Map<string, Promise<string>>();

/**
 * Makes a stored directory artifact available under `cacheRoot/<key>` and returns that directory. Concurrent
 * callers share one download; the directory appears atomically (extract to a temp name, then rename).
 */
export function fetchDir(stored: StoredArtifact, cacheRoot: string): Promise<string> {
  const dir = path.join(cacheRoot, stored.key);
  if (existsSync(dir)) return Promise.resolve(dir);
  let p = inflight.get(dir);
  if (!p) {
    p = (async () => {
      const tmp = path.join(cacheRoot, `.${stored.key}.${randomBytes(4).toString('hex')}`);
      try {
        await downloadArtifact(stored, `${tmp}.tgz`);
        await extractInto(createReadStream(`${tmp}.tgz`).pipe(createGunzip()), tmp);
        if (!existsSync(dir)) await rename(tmp, dir);
        return dir;
      } finally {
        await rm(`${tmp}.tgz`, { force: true });
        await rm(tmp, { recursive: true, force: true });
        inflight.delete(dir);
      }
    })();
    inflight.set(dir, p);
  }
  return p;
}

/** Maps a directory artifact built elsewhere onto a local copy rooted at `localRoot`. */
export function relocate<T extends { root: string; path: string }>(artifact: T, localRoot: string): T {
  const rel = path.relative(artifact.root, artifact.path);
  return { ...artifact, root: localRoot, path: path.join(localRoot, rel) };
}
