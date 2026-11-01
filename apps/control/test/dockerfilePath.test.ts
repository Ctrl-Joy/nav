// Dockerfile paths are confined to the repository: rejected when saved if absolute or climbing out, and resolved at
// build time (symlinks included) to a regular file inside the checkout, with a size limit.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DOCKERFILE_BYTES, resolveDockerfile } from '../src/agent/runtime/docker.ts';
import { repoPathError } from '../src/lib/services.ts';

const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-dockerfile-test-'));
after(() => rm(dir, { recursive: true, force: true }));

test('dockerfilePath / dockerContext must be relative paths inside the repository', () => {
  for (const ok of ['Dockerfile', 'docker/Dockerfile.prod', './Dockerfile', '.', 'api', 'a..b/Dockerfile']) assert.equal(repoPathError(ok), null, ok);
  for (const bad of ['/etc/passwd', '../Dockerfile', 'a/../../b', '..', 'C:/x/Dockerfile', 'c:Dockerfile', 'a\\..\\b', '~/Dockerfile', '', 'a\0b']) assert.ok(repoPathError(bad), bad);
});

test('the build only reads a regular Dockerfile inside the checkout', async () => {
  const src = path.join(dir, 'repo');
  const outside = path.join(dir, 'secret.txt');
  await mkdir(path.join(src, 'app', 'sub'), { recursive: true });
  await writeFile(path.join(src, 'app', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(outside, 'host secret\n');
  const appDir = path.join(src, 'app');

  assert.equal(path.basename(await resolveDockerfile(src, appDir, 'Dockerfile')), 'Dockerfile');
  await assert.rejects(resolveDockerfile(src, appDir, '../../secret.txt'), /inside the repository/);
  await assert.rejects(resolveDockerfile(src, appDir, outside), /inside the repository/);
  await assert.rejects(resolveDockerfile(src, appDir, 'missing'), /not found/);
  await assert.rejects(resolveDockerfile(src, appDir, 'sub'), /not a regular file/);
  await writeFile(path.join(appDir, 'Huge'), Buffer.alloc(MAX_DOCKERFILE_BYTES + 1, 0x41));
  await assert.rejects(resolveDockerfile(src, appDir, 'Huge'), /larger than/);

  // A Dockerfile committed as a symlink to a host file is refused (skipped where symlinks need privileges).
  const link = path.join(appDir, 'Linked');
  const made = await symlink(outside, link).then(() => true, () => false);
  if (made) await assert.rejects(resolveDockerfile(src, appDir, 'Linked'), /inside the repository/);
});
