// Path confinement for sandbox file operations: traversal, absolute paths and symlink escapes are refused.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathError, containerPath, isInside, resolveInside, sandboxSegments } from '../src/agent/sandbox/paths.ts';

let dir = '';
let root = '';
let outside = '';

before(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nav-sbx-paths-')));
  root = path.join(dir, 'root');
  outside = path.join(dir, 'outside');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'sub', 'a.txt'), 'inside');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Directory links: junctions on Windows (no privilege needed), symlinks elsewhere. */
async function dirLink(target: string, at: string): Promise<void> {
  await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

async function fileLink(target: string, at: string): Promise<boolean> {
  try {
    await symlink(target, at, 'file');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false; // Windows without symlink rights
    throw err;
  }
}

test('sandboxSegments normalizes the accepted spellings of a path', () => {
  assert.deepEqual(sandboxSegments('a/b.txt'), ['a', 'b.txt']);
  assert.deepEqual(sandboxSegments('/a/b.txt'), ['a', 'b.txt']);
  assert.deepEqual(sandboxSegments('/workspace/a/b.txt'), ['a', 'b.txt']);
  assert.deepEqual(sandboxSegments('./a//./b.txt'), ['a', 'b.txt']);
  assert.deepEqual(sandboxSegments(''), []);
  assert.deepEqual(sandboxSegments('/'), []);
  assert.deepEqual(sandboxSegments('/workspace'), []);
  // "/workspacefoo" is not the mount: it is a file called workspacefoo.
  assert.deepEqual(sandboxSegments('/workspacefoo'), ['workspacefoo']);
});

test('sandboxSegments refuses traversal and host-path tricks', () => {
  for (const bad of ['..', '../x', 'a/../../x', '/workspace/../etc/passwd', 'a/..', 'a\\..\\b', 'C:/Windows', 'c:x', 'file.txt:stream', 'a\0b', 'a/\x01b', `${'x'.repeat(256)}`]) {
    assert.throws(() => sandboxSegments(bad), PathError, `expected ${JSON.stringify(bad)} to be refused`);
  }
  assert.throws(() => sandboxSegments('x/'.repeat(3000)), PathError);
});

test('containerPath always lands under /workspace', () => {
  assert.equal(containerPath(''), '/workspace');
  assert.equal(containerPath('/etc/passwd'), '/workspace/etc/passwd');
  assert.equal(containerPath('/workspace/src/main.py'), '/workspace/src/main.py');
  assert.throws(() => containerPath('/workspace/../etc'), PathError);
});

test('isInside compares resolved paths', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
});

test('resolveInside reads, writes and deletes inside the root', async () => {
  assert.equal(await resolveInside(root, 'sub/a.txt', 'read'), path.join(root, 'sub', 'a.txt'));
  assert.equal(await resolveInside(root, '/workspace/sub/a.txt', 'read'), path.join(root, 'sub', 'a.txt'));
  // Missing parents are created for writes.
  assert.equal(await resolveInside(root, 'new/deep/file.txt', 'write'), path.join(root, 'new', 'deep', 'file.txt'));
  await assert.rejects(resolveInside(root, 'missing.txt', 'read'), (e: PathError) => e.status === 404);
  await assert.rejects(resolveInside(root, '../outside/secret.txt', 'read'), PathError);
  await assert.rejects(resolveInside(root, 'sub/a.txt/x', 'write'), PathError); // a file is not a directory
});

test('resolveInside refuses a directory link that leads outside', async () => {
  await dirLink(outside, path.join(root, 'escape'));
  await assert.rejects(resolveInside(root, 'escape/secret.txt', 'read'), (e: PathError) => e.status === 403);
  await assert.rejects(resolveInside(root, 'escape/new.txt', 'write'), (e: PathError) => e.status === 403);
  await assert.rejects(resolveInside(root, 'escape', 'read'), (e: PathError) => e.status === 403);
  // Deleting the link itself is fine: the link is removed, never followed.
  assert.equal(await resolveInside(root, 'escape', 'delete'), path.join(root, 'escape'));
  await assert.rejects(resolveInside(root, 'escape/secret.txt', 'delete'), (e: PathError) => e.status === 403);
});

test('resolveInside follows links that stay inside', async () => {
  await dirLink(path.join(root, 'sub'), path.join(root, 'alias'));
  assert.equal(await resolveInside(root, 'alias/a.txt', 'read'), path.join(root, 'sub', 'a.txt'));
});

test('resolveInside refuses a file symlink that leads outside', async (t) => {
  if (!(await fileLink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt')))) return t.skip('no symlink rights');
  await assert.rejects(resolveInside(root, 'leak.txt', 'read'), (e: PathError) => e.status === 403);
  await assert.rejects(resolveInside(root, 'leak.txt', 'write'), (e: PathError) => e.status === 403);
  assert.equal(await resolveInside(root, 'leak.txt', 'delete'), path.join(root, 'leak.txt'));
  if (await fileLink(path.join(outside, 'nope.txt'), path.join(root, 'dangling.txt'))) {
    await assert.rejects(resolveInside(root, 'dangling.txt', 'write'), PathError);
  }
});
