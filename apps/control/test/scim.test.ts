// SCIM request parsing: filters and PATCH operations in the shapes Okta and Microsoft Entra send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScimError, applyUserPatch, paging, parseFilter, parseGroupPatch, userFromResource, type UserState } from '../src/lib/scim.ts';

const base: UserState = { userName: 'ada@acme.test', externalId: null, givenName: 'Ada', familyName: 'L', displayName: null, email: 'ada@acme.test', active: true };
const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

test('filters: eq only, known attributes, quoted values', () => {
  assert.deepEqual(parseFilter('userName eq "ada@acme.test"', ['userName']), { attr: 'userName', value: 'ada@acme.test' });
  assert.deepEqual(parseFilter('USERNAME eq "a\\"b"', ['userName']), { attr: 'userName', value: 'a"b' });
  assert.equal(parseFilter(undefined, ['userName']), null);
  assert.throws(() => parseFilter('userName co "ada"', ['userName']), (e: unknown) => e instanceof ScimError && e.scimType === 'invalidFilter');
  assert.throws(() => parseFilter('title eq "x"', ['userName']), ScimError);
});

test('user resource: primary email, defaults, required userName', () => {
  const u = userFromResource({ userName: 'Ada@Acme.test', emails: [{ value: 'other@x.test' }, { value: 'ADA@acme.test', primary: true }] });
  assert.equal(u.email, 'ada@acme.test');
  assert.equal(u.active, true);
  assert.equal(userFromResource({ userName: 'x', active: 'False' }).active, false);
  assert.throws(() => userFromResource({}), ScimError);
});

test('PATCH: Entra style (string booleans, capitalised ops, filtered email path)', () => {
  const s = applyUserPatch(base, patch(
    { op: 'Replace', path: 'active', value: 'False' },
    { op: 'Add', path: 'emails[type eq "work"].value', value: 'ADA2@acme.test' },
    { op: 'Replace', path: 'name.familyName', value: 'Lovelace' },
    { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'R&D' },
  ));
  assert.equal(s.active, false);
  assert.equal(s.email, 'ada2@acme.test');
  assert.equal(s.familyName, 'Lovelace');
  assert.equal(base.active, true, 'input is not mutated');
});

test('PATCH: Okta style (no path, value object)', () => {
  const s = applyUserPatch(base, patch({ op: 'replace', value: { active: false, name: { givenName: 'Augusta' }, displayName: 'Augusta Ada' } }));
  assert.equal(s.active, false);
  assert.equal(s.givenName, 'Augusta');
  assert.equal(s.displayName, 'Augusta Ada');
});

test('PATCH: rejects malformed operations', () => {
  assert.throws(() => applyUserPatch(base, { Operations: 'x' }), ScimError);
  assert.throws(() => applyUserPatch(base, patch({ op: 'move', path: 'active', value: true })), ScimError);
  assert.throws(() => applyUserPatch(base, patch({ op: 'replace', path: 'active', value: 'maybe' })), ScimError);
  assert.throws(() => applyUserPatch(base, patch({ op: 'remove', path: 'userName' })), ScimError);
});

test('group PATCH: add, remove by filter, remove by value, replace, rename', () => {
  assert.deepEqual(parseGroupPatch(patch({ op: 'add', path: 'members', value: [{ value: 'u1' }, { value: 'u2' }] })), { add: ['u1', 'u2'], remove: [] });
  assert.deepEqual(parseGroupPatch(patch({ op: 'remove', path: 'members[value eq "u1"]' })), { add: [], remove: ['u1'] });
  assert.deepEqual(parseGroupPatch(patch({ op: 'Remove', path: 'members', value: [{ value: 'u2' }] })), { add: [], remove: ['u2'] });
  assert.deepEqual(parseGroupPatch(patch({ op: 'replace', path: 'members', value: [{ value: 'u3' }] })).replace, ['u3']);
  assert.equal(parseGroupPatch(patch({ op: 'replace', value: { id: 'g', displayName: 'Ops' } })).displayName, 'Ops');
  assert.throws(() => parseGroupPatch(patch({ op: 'add', path: 'members', value: [{}] })), ScimError);
});

test('paging: 1-based startIndex, capped count', () => {
  assert.deepEqual(paging({}), { offset: 0, limit: 100, startIndex: 1 });
  assert.deepEqual(paging({ startIndex: '11', count: '5000' }), { offset: 10, limit: 200, startIndex: 11 });
  assert.deepEqual(paging({ startIndex: '-3', count: '0' }), { offset: 0, limit: 0, startIndex: 1 });
});
