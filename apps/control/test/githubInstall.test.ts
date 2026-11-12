import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mayClaimInstallation, safeNext, signInstallState, verifyInstallState, withParam } from '../src/lib/githubInstall.ts';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

test('a signed install state round-trips', () => {
  const token = signInstallState('usr_1', 'ws_1', '/w/ws_1/new/web', KEY);
  const state = verifyInstallState(token, KEY);
  assert.equal(state?.u, 'usr_1');
  assert.equal(state?.w, 'ws_1');
  assert.equal(state?.n, '/w/ws_1/new/web');
});

test('a tampered, foreign-key or expired state is rejected', () => {
  const token = signInstallState('usr_1', 'ws_1', '', KEY, 1_000_000);
  assert.ok(verifyInstallState(token, KEY, 1_000_000 + 60_000));
  assert.equal(verifyInstallState(token, OTHER, 1_000_000 + 60_000), null, 'signed with another key');
  assert.equal(verifyInstallState(token, KEY, 1_000_000 + 16 * 60_000), null, 'expired');
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'usr_2', w: 'ws_1', n: '/w/ws_1', e: 9_999_999_999 })).toString('base64url');
  assert.equal(verifyInstallState(`${forged}.${sig}`, KEY, 1_000_000), null, 'payload swapped under an old signature');
  assert.equal(verifyInstallState(`${payload}.x`, KEY, 1_000_000), null);
  assert.equal(verifyInstallState(undefined, KEY), null);
  assert.equal(verifyInstallState('a.b.c', KEY), null);
});

test('the return path can only be inside the workspace', () => {
  assert.equal(safeNext('/w/ws_1/new/web?x=1', 'ws_1'), '/w/ws_1/new/web?x=1');
  assert.equal(safeNext('https://evil.example', 'ws_1'), '/w/ws_1');
  assert.equal(safeNext('//evil.example', 'ws_1'), '/w/ws_1');
  assert.equal(safeNext('/w/ws_2/new', 'ws_1'), '/w/ws_1');
  assert.equal(safeNext('/w/ws_1\\evil', 'ws_1'), '/w/ws_1');
  assert.equal(safeNext(undefined, 'ws_1'), '/w/ws_1');
  assert.equal(withParam('/w/ws_1', 'github', 'installed'), '/w/ws_1?github=installed');
  assert.equal(withParam('/w/ws_1?a=1', 'github', 'x y'), '/w/ws_1?a=1&github=x%20y');
});

test('who may claim an installation', () => {
  const user = { id: 1, login: 'me', type: 'User' };
  assert.deepEqual(mayClaimInstallation({ id: 9, account: user }, 1, [], []), { ok: true });
  assert.equal(mayClaimInstallation({ id: 9, account: user }, 2, [], []).ok, false, 'someone else\'s account');
  assert.equal(mayClaimInstallation({ id: 9, account: user }, null, [], []).ok, false, 'GitHub not connected');
  const org = { id: 5, login: 'acme', type: 'Organization' };
  assert.equal(mayClaimInstallation({ id: 9, account: org }, 1, ['acme/api'], [{ fullName: 'Acme/API', admin: true }]).ok, true);
  assert.equal(mayClaimInstallation({ id: 9, account: org }, 1, ['acme/api'], [{ fullName: 'acme/api', admin: false }]).ok, false, 'member without admin');
  assert.equal(mayClaimInstallation({ id: 9, account: org }, 1, ['acme/api'], [{ fullName: 'other/x', admin: true }]).ok, false, 'admin elsewhere');
});
