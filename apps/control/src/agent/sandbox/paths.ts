// Path confinement for sandbox file operations. Every path a client sends is relative to the sandbox's
// /workspace: `..` segments, NUL bytes, backslashes and drive letters are refused outright, and on disk each
// component is resolved through realpath so a symlink (planted by code running in the sandbox) can never lead a
// read, write or delete outside the sandbox root.
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_MOUNT = '/workspace';
const MAX_PATH = 4096;
const MAX_SEGMENT = 255;

export class PathError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Splits a client path into safe segments relative to the sandbox root. `/workspace/a/b`, `/a/b`, `a/b` and
 * `./a/b` all name the same file; '' and '/' name the root itself (no segments).
 */
export function sandboxSegments(input: string): string[] {
  if (typeof input !== 'string') throw new PathError('path must be a string');
  if (input.length > MAX_PATH) throw new PathError('path is too long');
  if (input.includes('\0')) throw new PathError('path contains a NUL byte');
  if (input.includes('\\')) throw new PathError('use forward slashes in sandbox paths');
  let p = input;
  if (p === WORKSPACE_MOUNT || p.startsWith(`${WORKSPACE_MOUNT}/`)) p = p.slice(WORKSPACE_MOUNT.length);
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  for (const s of segments) {
    if (s === '..') throw new PathError('path may not contain ".." segments');
    if (s.length > MAX_SEGMENT) throw new PathError('path segment is too long');
    // Drive letters and NTFS alternate data streams on Windows hosts.
    if (s.includes(':')) throw new PathError('path may not contain ":"');
    if (/[\x00-\x1f]/.test(s)) throw new PathError('path contains control characters');
  }
  return segments;
}

/** The path as the sandbox sees it: always under /workspace. */
export function containerPath(input: string): string {
  const segs = sandboxSegments(input);
  return segs.length ? `${WORKSPACE_MOUNT}/${segs.join('/')}` : WORKSPACE_MOUNT;
}

/** True when `candidate` is `root` or lies under it (both absolute and already resolved). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function lstatOrNull(p: string) {
  return lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  });
}

export type ResolveMode =
  /** The target must exist; symlinks are followed (and must stay inside). */
  | 'read'
  /** Parents are created as needed; an existing symlink target is followed (and must stay inside). */
  | 'write'
  /** The target must exist; a final symlink is not followed (the link itself is removed). */
  | 'delete';

/**
 * Resolves a client path to an absolute host path inside `root`, refusing anything that would escape it through
 * `..`, an absolute path, or a symlink at any level.
 */
export async function resolveInside(root: string, input: string, mode: ResolveMode): Promise<string> {
  const base = await realpath(root);
  const segs = sandboxSegments(input);
  let cur = base;
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const next = path.join(cur, segs[i]);
    const st = await lstatOrNull(next);
    if (!st) {
      if (mode !== 'write') throw new PathError('no such file or directory', 404);
      if (last) return next;
      await mkdir(next);
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (last && mode === 'delete') return next;
      const target = await realpath(next).catch(() => null);
      if (!target) {
        throw new PathError(mode === 'write' && last ? 'refusing to write through a dangling symlink' : 'no such file or directory', mode === 'write' ? 400 : 404);
      }
      if (!isInside(base, target)) throw new PathError('path escapes the sandbox through a symlink', 403);
      cur = target;
    } else {
      cur = next;
    }
    if (!last && !(await lstatOrNull(cur))?.isDirectory()) throw new PathError('a parent of the path is not a directory');
  }
  if (!isInside(base, cur)) throw new PathError('path escapes the sandbox', 403);
  return cur;
}
