import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChecks, previewCommentBody } from '../src/lib/github.ts';
import { eventVerdict } from '../src/lib/checks.ts';
import { buildSecrets, buildxArgs, usesBuildSecrets } from '../src/agent/runtime/docker.ts';
import { parseBlueprint } from '../src/lib/blueprints.ts';

test('evaluateChecks: all passing conclusions deploy', () => {
  assert.equal(evaluateChecks([{ context: 'ci/lint', state: 'success' }], [
    { name: 'test', status: 'completed', conclusion: 'success' },
    { name: 'docs', status: 'completed', conclusion: 'skipped' },
    { name: 'optional', status: 'completed', conclusion: 'neutral' },
  ]), 'success');
  assert.equal(evaluateChecks([], []), 'success');
});

test('evaluateChecks: running checks keep the commit pending', () => {
  assert.equal(evaluateChecks([], [{ name: 'test', status: 'in_progress', conclusion: null }]), 'pending');
  assert.equal(evaluateChecks([{ context: 'ci', state: 'pending' }], []), 'pending');
});

test('evaluateChecks: any failure wins, even while others run', () => {
  assert.equal(evaluateChecks([], [{ name: 'a', status: 'completed', conclusion: 'failure' }, { name: 'b', status: 'queued', conclusion: null }]), 'failure');
  assert.equal(evaluateChecks([], [{ name: 'a', status: 'completed', conclusion: 'timed_out' }]), 'failure');
  assert.equal(evaluateChecks([{ context: 'ci', state: 'error' }], []), 'failure');
});

test("evaluateChecks ignores NAV's own commit status", () => {
  assert.equal(evaluateChecks([{ context: 'NAV', state: 'pending' }, { context: 'ci', state: 'success' }], []), 'success');
  assert.equal(evaluateChecks([{ context: 'NAV', state: 'failure' }], []), 'success');
});

test('eventVerdict reads completed check suites, check runs and statuses', () => {
  assert.deepEqual(eventVerdict('check_suite', { action: 'completed', check_suite: { head_sha: 'abc', conclusion: 'success' } }), { sha: 'abc', verdict: 'success' });
  assert.deepEqual(eventVerdict('check_run', { action: 'completed', check_run: { head_sha: 'abc', conclusion: 'cancelled' } }), { sha: 'abc', verdict: 'failure' });
  assert.deepEqual(eventVerdict('status', { sha: 'abc', context: 'ci', state: 'pending' }), { sha: 'abc', verdict: 'pending' });
  assert.equal(eventVerdict('check_suite', { action: 'requested', check_suite: { head_sha: 'abc' } }), null);
  assert.equal(eventVerdict('status', { sha: 'abc', context: 'NAV', state: 'success' }), null);
});

test('previewCommentBody renders one row per service and escapes table cells', () => {
  const body = previewCommentBody('shop | stack', [
    { name: 'web-pr-3', status: 'live', url: 'http://web-pr-3.nav.localhost:7080', dashboardUrl: 'http://localhost:5180/w/ws/services/srv_1' },
    { name: 'worker-pr-3', status: 'failed', url: null, dashboardUrl: 'http://localhost:5180/w/ws/services/srv_2' },
  ]);
  assert.match(body, /NAV preview: shop \\\| stack/);
  assert.match(body, /\| web-pr-3 \| ✅ Live \| \[web-pr-3\.nav\.localhost:7080\]\(http:\/\/web-pr-3\.nav\.localhost:7080\) \|/);
  assert.match(body, /\| worker-pr-3 \| ❌ Failed \| — \|/);
});

test('usesBuildSecrets detects secret mounts only', () => {
  assert.equal(usesBuildSecrets('FROM node\nRUN --mount=type=secret,id=NPM_TOKEN npm ci'), true);
  assert.equal(usesBuildSecrets('FROM node\nRUN --mount=target=/root/.npm,type=cache --mount=type=secret,id=X true'), true);
  assert.equal(usesBuildSecrets('FROM node\nRUN --mount=type=cache,target=/root/.npm npm ci'), false);
});

test('buildSecrets: env vars and secret files become ids; files win; unsafe names are dropped', () => {
  const s = buildSecrets({ NPM_TOKEN: 't', 'bad-key': 'x', API: 'env' }, [{ filename: '.npmrc', content: 'rc' }, { filename: 'API', content: 'file' }, { filename: '../escape', content: 'no' }]);
  assert.deepEqual(s, [{ id: 'NPM_TOKEN', content: 't' }, { id: 'API', content: 'file' }, { id: '.npmrc', content: 'rc' }]);
});

test('buildxArgs passes secrets by file reference, never as build args', () => {
  const args = buildxArgs({
    tag: 'nav/srv:dep', dockerfile: '/src/Dockerfile', contextDir: '/src', noCache: true,
    secrets: [{ id: 'NPM_TOKEN', src: '/tmp/nav-secrets-1/s0' }],
    buildArgs: { NAV_GIT_COMMIT: 'abc' }, labels: { 'nav.service': 'srv' },
  });
  assert.deepEqual(args, [
    'buildx', 'build', '--progress=plain', '--load', '-t', 'nav/srv:dep', '-f', '/src/Dockerfile',
    '--label', 'nav.service=srv', '--build-arg', 'NAV_GIT_COMMIT=abc', '--secret', 'id=NPM_TOKEN,src=/tmp/nav-secrets-1/s0', '--no-cache', '/src',
  ]);
  assert.ok(!args.join(' ').includes('NPM_TOKEN=t'));
});

test('parseBlueprint accepts blueprint previews and autoDeployTrigger', () => {
  const spec = parseBlueprint(`
previews:
  generation: automatic
  expireAfterDays: 3
services:
  - type: web
    name: api
    autoDeployTrigger: checksPass
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: db, property: connectionString }
databases:
  - name: db
`);
  assert.deepEqual(spec.previews, { generation: 'automatic', expireAfterDays: 3 });
  assert.equal(spec.services[0].autoDeployTrigger, 'checksPass');
  assert.equal(parseBlueprint('services: []').previews, undefined);
  assert.throws(() => parseBlueprint('previews: { generation: sometimes }'));
});
