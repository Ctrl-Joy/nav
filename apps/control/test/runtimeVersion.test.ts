// Native builds use full Python/Ruby images (compilers and libpq headers) and honour a pinned language version,
// from an env var or a version file.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeDockerfile, pinnedVersion } from '../src/agent/runtime/docker.ts';

const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-runtime-version-test-'));
after(() => rm(dir, { recursive: true, force: true }));

test('python and ruby build on full images that can compile native extensions', () => {
  assert.match(nativeDockerfile('python', 'pip install -r requirements.txt', null, []), /^FROM python:3\.13-bookworm\n/);
  assert.match(nativeDockerfile('ruby', null, null, []), /^FROM ruby:3\.4-bookworm\n/);
  assert.match(nativeDockerfile('node', null, null, []), /^FROM node:22-bookworm-slim\n/);
});

test('a pinned version picks the image tag', () => {
  assert.match(nativeDockerfile('python', null, null, [], '3.12'), /^FROM python:3\.12-bookworm\n/);
  assert.match(nativeDockerfile('node', null, null, [], '20'), /^FROM node:20-bookworm-slim\n/);
  assert.match(nativeDockerfile('go', null, null, [], '1.22'), /^FROM golang:1\.25-bookworm\n/);
});

test('the version comes from the env var first, then version files', async () => {
  const app = await mkdtemp(path.join(dir, 'app-'));
  assert.equal(await pinnedVersion('python', app, {}), null);
  await writeFile(path.join(app, 'runtime.txt'), 'python-3.11.9\n');
  assert.equal(await pinnedVersion('python', app, {}), '3.11.9');
  await writeFile(path.join(app, '.python-version'), '3.12\n');
  assert.equal(await pinnedVersion('python', app, {}), '3.12');
  assert.equal(await pinnedVersion('python', app, { PYTHON_VERSION: '3.10.4' }), '3.10.4');
  await writeFile(path.join(app, '.nvmrc'), 'v20.11.0\n');
  assert.equal(await pinnedVersion('node', app, {}), '20.11.0');
  assert.equal(await pinnedVersion('go', app, { GO_VERSION: '1.22' }), null);
});

test('anything but a plain version number is ignored', async () => {
  const app = await mkdtemp(path.join(dir, 'app-'));
  for (const bad of ['lts/iron', '3.12; rm -rf /', '3.12-slim', 'latest', ' ']) {
    assert.equal(await pinnedVersion('python', app, { PYTHON_VERSION: bad }), null, bad);
  }
});
