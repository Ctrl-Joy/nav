import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTokenReply, clientIdHint, normalizeBaseUrl, resolveEffective, testProvider } from '../src/lib/providerChecks.ts';

const none = { clientId: '', clientSecret: '' };
const saved = { clientId: 'saved-id-1234', clientSecret: 'saved-secret', baseUrl: 'https://git.example.com' };

test('environment variables win over saved credentials', () => {
  const eff = resolveEffective('github', { clientId: 'env-id', clientSecret: 'env-secret' }, saved);
  assert.equal(eff.source, 'environment');
  assert.equal(eff.clientId, 'env-id');
  assert.equal(eff.enabled, true);
});

test('a half-set environment still owns the provider, and is not enabled', () => {
  const eff = resolveEffective('google', { clientId: 'env-id', clientSecret: '' }, saved);
  assert.equal(eff.source, 'environment');
  assert.equal(eff.enabled, false);
});

test('saved credentials apply when the environment is empty', () => {
  const eff = resolveEffective('gitlab', none, saved, 'https://gitlab.com');
  assert.deepEqual(eff, { source: 'database', clientId: 'saved-id-1234', clientSecret: 'saved-secret', baseUrl: 'https://git.example.com', enabled: true });
  assert.equal(resolveEffective('gitlab', none, { ...saved, baseUrl: null }, 'https://gitlab.com').baseUrl, 'https://gitlab.com');
  assert.equal(resolveEffective('bitbucket', none, saved).baseUrl, null);
});

test('nothing configured is disabled', () => {
  const eff = resolveEffective('bitbucket', none, null);
  assert.equal(eff.source, null);
  assert.equal(eff.enabled, false);
});

test('clientIdHint reveals only the last four characters of a long id', () => {
  assert.equal(clientIdHint('Ov23liABCDEFGH1234'), '…1234');
  assert.equal(clientIdHint('short'), '…');
  assert.equal(clientIdHint(''), null);
});

test('normalizeBaseUrl accepts https and localhost, rejects the rest', () => {
  assert.equal(normalizeBaseUrl('https://gitlab.example.com/'), 'https://gitlab.example.com');
  assert.equal(normalizeBaseUrl('https://example.com/gitlab//'), 'https://example.com/gitlab');
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.throws(() => normalizeBaseUrl('http://gitlab.example.com'));
  assert.throws(() => normalizeBaseUrl('https://user:pw@gitlab.example.com'));
  assert.throws(() => normalizeBaseUrl('https://gitlab.example.com/?x=1'));
  assert.throws(() => normalizeBaseUrl('gitlab.example.com'));
});

test('token endpoint answers are classified per provider', () => {
  assert.equal(classifyTokenReply('github', { status: 200, error: 'bad_verification_code', description: '' }).status, 'pass');
  assert.equal(classifyTokenReply('github', { status: 200, error: 'incorrect_client_credentials', description: '' }).status, 'fail');
  assert.equal(classifyTokenReply('github', { status: 200, error: 'redirect_uri_mismatch', description: '' }).status, 'warn');
  assert.equal(classifyTokenReply('gitlab', { status: 400, error: 'invalid_grant', description: '' }).status, 'pass');
  assert.equal(classifyTokenReply('gitlab', { status: 401, error: 'invalid_client', description: '' }).status, 'fail');
  assert.equal(classifyTokenReply('bitbucket', { status: 400, error: 'invalid_client', description: 'Invalid OAuth client credentials' }).status, 'fail');
  assert.equal(classifyTokenReply('google', { status: 400, error: 'invalid_grant', description: 'Malformed auth code.' }).status, 'pass');
  assert.equal(classifyTokenReply('google', { status: 500, error: '', description: '' }).status, 'skip');
});

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('GitHub test passes when only the code is rejected', async () => {
  const f = fakeFetch({ 'https://github.com/login/oauth/access_token': { body: { error: 'bad_verification_code' } } });
  const r = await testProvider('github', { clientId: 'Ov23liABCDEFGHIJKLMN', clientSecret: 's' }, 'http://x/cb', f);
  assert.equal(r.ok, true);
});

test('Google test fails on a malformed client id even when the endpoint accepts it', async () => {
  const f = fakeFetch({
    'https://accounts.google.com/.well-known/openid-configuration': { body: {} },
    'https://oauth2.googleapis.com/token': { status: 400, body: { error: 'invalid_grant' } },
  });
  const r = await testProvider('google', { clientId: 'not-a-google-id', clientSecret: 's' }, 'http://x/cb', f);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.label === 'Client ID format')?.status, 'fail');
});

test('GitLab test reports an unreachable instance without trying the token endpoint', async () => {
  const f = (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  const r = await testProvider('gitlab', { clientId: 'id', clientSecret: 's', baseUrl: 'https://nowhere.example' }, 'http://x/cb', f);
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 1);
});

test('missing credentials fail without any request', async () => {
  const r = await testProvider('bitbucket', { clientId: 'id', clientSecret: '' }, 'http://x/cb', fakeFetch({}));
  assert.equal(r.ok, false);
});
