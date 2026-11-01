// End to end: organizations, verified domains, SAML sign-in through the real routes (with a throwaway IdP) and SCIM
// provisioning, against a private PostgreSQL cluster (embedded-postgres binaries) on a spare port.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

const PORT = Number(process.env.NAV_TEST_PG_PORT ?? 5491);
const PASSWORD = 'navtest';
const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-orgs-test-'));
process.env.NAV_DATABASE_URL = `postgres://nav:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
process.env.NAV_MASTER_KEY ??= 'a'.repeat(64);
process.env.NAV_DATA_DIR = path.join(dir, 'nav');

const cluster = await import('../src/lib/pgcluster.ts');
const spec = { dataDir: path.join(dir, 'pg'), port: PORT, superuser: 'nav', password: PASSWORD, listen: '127.0.0.1' };

let app: FastifyInstance;
let db: typeof import('../src/db/pool.ts');
let saml: typeof import('../src/lib/saml.ts');

before(async () => {
  await cluster.initCluster(spec);
  await cluster.startCluster(spec);
  db = await import('../src/db/pool.ts');
  saml = await import('../src/lib/saml.ts');
  await (await import('../src/db/migrate.ts')).migrate();
  app = await (await import('../src/http/app.ts')).buildApp();
});

after(async () => {
  await app?.close();
  await db?.pool.end();
  await cluster.stopCluster(spec.dataDir, 'immediate').catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

type Res = { status: number; body: any; headers: Record<string, any>; cookies: { name: string; value: string }[] };

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string; bearer?: string; form?: Record<string, string>; scim?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.cookie && method !== 'GET') headers['x-nav-csrf'] = '1';
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let payload: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['content-type'] = opts.scim ? 'application/scim+json' : 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await app.inject({ method: method as 'GET', url, headers, payload });
  let body: any = res.body;
  try { body = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.statusCode, body, headers: res.headers, cookies: res.cookies.map((c) => ({ name: c.name, value: c.value })) };
}

const sessionOf = (r: Res) => {
  const c = r.cookies.find((x) => x.name === 'nav_session');
  assert.ok(c, `expected a session cookie (status ${r.status})`);
  return `nav_session=${c.value}`;
};

async function signup(email: string): Promise<string> {
  const r = await call('POST', '/api/v1/auth/signup', { body: { email, password: 'correct horse battery' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return sessionOf(r);
}

let admin = '';
let orgId = '';
let workspaceId = '';
let idp: Awaited<ReturnType<typeof import('./helpers/idp.ts').createIdp>>;

/** Starts SP-initiated sign-in and returns the AuthnRequest id the IdP must answer. */
async function startLogin(next = '/app'): Promise<string> {
  const r = await call('GET', `/api/v1/auth/saml/${orgId}/login?next=${encodeURIComponent(next)}`);
  assert.equal(r.status, 302);
  const url = new URL(r.headers.location);
  assert.equal(url.origin + url.pathname, 'https://idp.acme.test/sso');
  assert.ok(url.searchParams.get('Signature'), 'AuthnRequest is signed');
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  return /ID="([^"]+)"/.exec(xml)![1];
}

test('org admin creates an org, verifies a domain and configures SAML', async () => {
  admin = await signup('owner@corp-admin.test');
  const created = await call('POST', '/api/v1/orgs', { cookie: admin, body: { name: 'Acme' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  orgId = created.body.id;
  workspaceId = created.body.defaultWorkspaceId;
  assert.ok(workspaceId);

  const me = await call('GET', '/api/v1/auth/me', { cookie: admin });
  assert.equal(me.body.orgs[0].id, orgId);
  assert.equal(me.body.workspaces.find((w: any) => w.id === workspaceId).orgId, orgId);

  // SAML cannot be turned on without a verified domain.
  const early = await call('PUT', `/api/v1/orgs/${orgId}/saml`, { cookie: admin, body: { enabled: true } });
  assert.equal(early.status, 400);

  const dom = await call('POST', `/api/v1/orgs/${orgId}/domains`, { cookie: admin, body: { domain: 'acme.test' } });
  assert.equal(dom.status, 201);
  assert.equal(dom.body.txtName, '_nav-verify.acme.test');
  assert.match(dom.body.txtValue, /^nav-verify=/);
  const verified = await call('POST', `/api/v1/orgs/${orgId}/domains/${dom.body.id}/verify`, { cookie: admin });
  assert.equal(verified.body.verified, true, '.test domains verify without DNS outside production');

  const sp = await call('GET', `/api/v1/orgs/${orgId}/saml`, { cookie: admin });
  assert.equal(sp.status, 200);
  assert.equal(sp.body.sp.acsUrl, saml.acsUrl(orgId));
  const { createIdp } = await import('./helpers/idp.ts');
  idp = await createIdp('https://idp.acme.test/entity', { entityId: sp.body.sp.entityId, acsUrl: sp.body.sp.acsUrl });
  const put = await call('PUT', `/api/v1/orgs/${orgId}/saml`, { cookie: admin, body: { metadataXml: idp.metadataXml('https://idp.acme.test/sso'), enabled: true } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.configured, true);
  assert.equal(put.body.idp.entityId, 'https://idp.acme.test/entity');

  const md = await call('GET', `/api/v1/auth/saml/${orgId}/metadata`);
  assert.equal(md.status, 200);
  assert.match(String(md.body), /AssertionConsumerService/);
});

test('/auth/sso routes a verified-domain email to the org SAML login', async () => {
  const r = await call('POST', '/api/v1/auth/sso', { body: { email: 'someone@acme.test' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.redirect, `/api/v1/auth/saml/${orgId}/login?login_hint=someone%40acme.test`);
  const other = await call('POST', '/api/v1/auth/sso', { body: { email: 'someone@elsewhere.test' } });
  assert.equal(other.status, 404);
});

test('SAML sign-in provisions the user just in time; the response cannot be replayed', async () => {
  const rid = await startLogin('/w/x');
  const response = idp.signedAssertionResponse({ requestId: rid, email: 'ada@acme.test' });
  const r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: response } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'http://localhost:5180/w/x');
  const ada = sessionOf(r);
  const me = await call('GET', '/api/v1/auth/me', { cookie: ada });
  assert.equal(me.body.user.email, 'ada@acme.test');
  assert.equal(me.body.user.emailVerified, true);
  assert.deepEqual(me.body.orgs.map((o: any) => [o.id, o.role]), [[orgId, 'member']]);
  assert.deepEqual(me.body.workspaces.map((w: any) => [w.id, w.role]), [[workspaceId, 'developer']]);

  const replay = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: response } });
  assert.equal(replay.status, 302);
  assert.match(replay.headers.location, /error=saml_expired/);
  assert.ok(!replay.cookies.some((c) => c.name === 'nav_session'));

  const log = await db.q("SELECT action, actor_kind, data FROM audit_logs WHERE org_id = $1 AND actor_kind = 'saml' ORDER BY id", [orgId]);
  assert.deepEqual(log.map((l) => l.action), ['saml.login', 'saml.login_failed']);
  assert.equal(log[0].actor_kind, 'saml');
});

test('SAML rejects tampered, unsolicited and out-of-domain responses', async () => {
  let rid = await startLogin();
  const tampered = Buffer.from(idp.signedAssertionResponse({ requestId: rid, email: 'bob@acme.test' }), 'base64').toString('utf8').replaceAll('bob@acme.test', 'owner@corp-admin.test');
  let r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: Buffer.from(tampered).toString('base64') } });
  assert.match(r.headers.location, /error=saml_invalid/);

  r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: saml.newRequestId() }) } });
  assert.match(r.headers.location, /error=saml_expired/, 'a response to a request we never issued');

  rid = await startLogin();
  r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, email: 'eve@not-verified.test' }) } });
  assert.match(r.headers.location, /error=saml_domain/);
  assert.equal((await db.q("SELECT 1 FROM users WHERE email = 'eve@not-verified.test'")).length, 0);
});

test('SAML takes over an unverified password account squatting on a verified-domain address', async () => {
  const squatter = await signup('carl@acme.test');
  await call('POST', '/api/v1/api-keys', { cookie: squatter, body: { name: 'mine' } });
  const rid = await startLogin();
  const r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, email: 'carl@acme.test' }) } });
  assert.equal(r.headers.location, 'http://localhost:5180/app');
  const u = (await db.one("SELECT * FROM users WHERE email = 'carl@acme.test'"))!;
  assert.equal(u.password_hash, null);
  assert.equal((await db.q('SELECT 1 FROM api_keys WHERE user_id = $1', [u.id])).length, 0);
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: squatter })).status, 401, 'the squatter\'s session is gone');
});

test('SAML sign-in goes through 2FA', async () => {
  await db.q("UPDATE users SET totp_enabled_at = now() WHERE email = 'ada@acme.test'");
  const rid = await startLogin();
  const r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, email: 'ada@acme.test' }) } });
  assert.equal(r.headers.location, 'http://localhost:5180/login/mfa');
  assert.ok(!r.cookies.some((c) => c.name === 'nav_session'), 'no session before the second factor');
  assert.ok(r.cookies.some((c) => c.name === 'nav_mfa'));
  await db.q("UPDATE users SET totp_enabled_at = NULL WHERE email = 'ada@acme.test'");
});

test('enforced SSO refuses password sign-in and sign-up for verified-domain accounts', async () => {
  const before = await signup('dana@acme.test');
  assert.ok(before);
  const enforce = await call('PUT', `/api/v1/orgs/${orgId}/saml`, { cookie: admin, body: { enabled: true, enforce: true } });
  assert.equal(enforce.status, 200, JSON.stringify(enforce.body));
  const login = await call('POST', '/api/v1/auth/login', { body: { email: 'dana@acme.test', password: 'correct horse battery' } });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, 'sso_required');
  const su = await call('POST', '/api/v1/auth/signup', { body: { email: 'erin@acme.test', password: 'correct horse battery' } });
  assert.equal(su.body.error.code, 'sso_required');
  // Other domains are unaffected.
  const ok = await call('POST', '/api/v1/auth/login', { body: { email: 'owner@corp-admin.test', password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  await call('PUT', `/api/v1/orgs/${orgId}/saml`, { cookie: admin, body: { enabled: true, enforce: false } });
});

test('org admins see and manage every org workspace; members only their own', async () => {
  const ws2 = await call('POST', `/api/v1/orgs/${orgId}/workspaces`, { cookie: admin, body: { name: 'Acme Staging' } });
  assert.equal(ws2.status, 201);
  const ada = (await db.one("SELECT id FROM users WHERE email = 'ada@acme.test'"))!;
  const adminUser = (await db.one("SELECT id FROM users WHERE email = 'owner@corp-admin.test'"))!;
  // A second admin who is not a member of Acme Staging still gets admin on it.
  await call('PATCH', `/api/v1/orgs/${orgId}/members/${ada.id}`, { cookie: admin, body: { role: 'admin' } });
  const rid = await startLogin();
  const adaSession = sessionOf(await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, email: 'ada@acme.test' }) } }));
  const list = await call('GET', `/api/v1/orgs/${orgId}/workspaces`, { cookie: adaSession });
  assert.equal(list.body.items.length, 2);
  const members = await call('GET', `/api/v1/workspaces/${ws2.body.id}/members`, { cookie: adaSession });
  assert.equal(members.status, 200);
  await call('PATCH', `/api/v1/orgs/${orgId}/members/${ada.id}`, { cookie: admin, body: { role: 'member' } });
  const denied = await call('GET', `/api/v1/workspaces/${ws2.body.id}/members`, { cookie: adaSession });
  assert.equal(denied.status, 404);
  // The last owner cannot be demoted.
  const demote = await call('PATCH', `/api/v1/orgs/${orgId}/members/${adminUser.id}`, { cookie: admin, body: { role: 'admin' } });
  assert.equal(demote.status, 409);
});

test('org-level 2FA requirement applies to the org\'s workspaces', async () => {
  const noMfa = await call('PATCH', `/api/v1/orgs/${orgId}`, { cookie: admin, body: { requireTwoFactor: true } });
  assert.equal(noMfa.status, 400, 'the admin needs 2FA first');
  await db.q('UPDATE orgs SET require_2fa = true WHERE id = $1', [orgId]);
  const rid = await startLogin();
  const ada = sessionOf(await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, email: 'ada@acme.test' }) } }));
  const r = await call('GET', `/api/v1/workspaces/${workspaceId}/members`, { cookie: ada });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'mfa_required');
  await db.q('UPDATE orgs SET require_2fa = false WHERE id = $1', [orgId]);
});

test('SCIM provisions, maps groups to roles, deprovisions and audits', async () => {
  const tok = await call('POST', `/api/v1/orgs/${orgId}/scim/tokens`, { cookie: admin, body: { name: 'Okta' } });
  assert.equal(tok.status, 201);
  const token = tok.body.token as string;
  assert.equal((await db.q('SELECT 1 FROM scim_tokens WHERE token_hash = $1', [token])).length, 0, 'only the hash is stored');

  assert.equal((await call('GET', '/scim/v2/Users', { bearer: 'nope' })).status, 401);
  const spc = await call('GET', '/scim/v2/ServiceProviderConfig', { bearer: token });
  assert.equal(spc.body.patch.supported, true);
  assert.equal((await call('GET', '/scim/v2/Schemas', { bearer: token })).body.totalResults, 2);

  const outside = await call('POST', '/scim/v2/Users', { bearer: token, scim: true, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'x@elsewhere.test', active: true } });
  assert.equal(outside.status, 400);
  assert.equal(outside.body.scimType, 'invalidValue');

  const created = await call('POST', '/scim/v2/Users', {
    bearer: token, scim: true,
    body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'frank@acme.test', name: { givenName: 'Frank', familyName: 'Lin' }, emails: [{ value: 'frank@acme.test', primary: true }], active: true, externalId: 'okta-1' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.headers['content-type'], /application\/scim\+json/);
  const scimId = created.body.id;
  const dup = await call('POST', '/scim/v2/Users', { bearer: token, scim: true, body: { userName: 'FRANK@acme.test' } });
  assert.equal(dup.status, 409);

  const found = await call('GET', `/scim/v2/Users?filter=${encodeURIComponent('userName eq "frank@acme.test"')}`, { bearer: token });
  assert.equal(found.body.totalResults, 1);
  assert.equal(found.body.Resources[0].name.givenName, 'Frank');

  const frank = (await db.one("SELECT id FROM users WHERE email = 'frank@acme.test'"))!;
  assert.ok(await db.one('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, frank.id]));
  assert.equal((await db.one('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, frank.id]))?.role, 'developer');

  // Group mapped to admin in a second workspace.
  const ws3 = (await call('POST', `/api/v1/orgs/${orgId}/workspaces`, { cookie: admin, body: { name: 'Acme Prod' } })).body.id;
  const group = await call('POST', '/scim/v2/Groups', { bearer: token, scim: true, body: { displayName: 'Platform', members: [] } });
  assert.equal(group.status, 201);
  const map = await call('PATCH', `/api/v1/orgs/${orgId}/scim/groups/${group.body.id}`, { cookie: admin, body: { workspaceId: ws3, role: 'admin' } });
  assert.equal(map.status, 200, JSON.stringify(map.body));
  const add = await call('PATCH', `/scim/v2/Groups/${group.body.id}`, { bearer: token, scim: true, body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'add', path: 'members', value: [{ value: scimId }] }] } });
  assert.equal(add.status, 204);
  assert.equal((await db.one('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws3, frank.id]))?.role, 'admin');
  const rm1 = await call('PATCH', `/scim/v2/Groups/${group.body.id}`, { bearer: token, scim: true, body: { Operations: [{ op: 'remove', path: `members[value eq "${scimId}"]` }] } });
  assert.equal(rm1.status, 204);
  assert.equal(await db.one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws3, frank.id]), null);
  await call('PATCH', `/scim/v2/Groups/${group.body.id}`, { bearer: token, scim: true, body: { Operations: [{ op: 'add', path: 'members', value: [{ value: scimId }] }] } });

  // Frank signs in (SAML) and makes an API key; Entra-style deactivation revokes both and removes memberships.
  const rid = await startLogin();
  const frankSession = sessionOf(await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, email: 'frank@acme.test' }) } }));
  const key = await call('POST', '/api/v1/api-keys', { cookie: frankSession, body: { name: 'ci' } });
  assert.equal(key.status, 201);
  const off = await call('PATCH', `/scim/v2/Users/${scimId}`, { bearer: token, scim: true, body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.active, false);
  assert.equal(await db.one('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, frank.id]), null);
  assert.equal((await db.q('SELECT 1 FROM workspace_members WHERE user_id = $1', [frank.id])).length, 0);
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: frankSession })).status, 401, 'session revoked');
  assert.equal((await call('GET', '/api/v1/auth/me', { bearer: key.body.token })).status, 401, 'API key revoked');

  // A deactivated user cannot come back through SAML.
  const rid2 = await startLogin();
  const back = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid2, email: 'frank@acme.test' }) } });
  assert.match(back.headers.location, /error=saml_deprovisioned/);

  // Okta-style reactivation restores org + default workspace + group role.
  const on = await call('PATCH', `/scim/v2/Users/${scimId}`, { bearer: token, scim: true, body: { Operations: [{ op: 'replace', value: { active: true } }] } });
  assert.equal(on.body.active, true);
  assert.equal((await db.one('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws3, frank.id]))?.role, 'admin');

  const del = await call('DELETE', `/scim/v2/Users/${scimId}`, { bearer: token });
  assert.equal(del.status, 204);
  assert.equal((await call('GET', `/scim/v2/Users/${scimId}`, { bearer: token })).status, 404);
  assert.equal((await db.q('SELECT 1 FROM workspace_members WHERE user_id = $1', [frank.id])).length, 0);

  const audit = await call('GET', `/api/v1/orgs/${orgId}/audit-logs`, { cookie: admin });
  const actions = audit.body.items.map((i: any) => i.action);
  for (const a of ['scim.user.create', 'scim.user.deactivate', 'scim.user.reactivate', 'scim.user.delete', 'scim.group.create', 'saml.login', 'org_domain.verify', 'saml.update', 'scim_group.update', 'org.create']) {
    assert.ok(actions.includes(a), `audit log has ${a} (got ${[...new Set(actions)].join(', ')})`);
  }
});

test('a known SAML identity is refused when the IdP asserts a different email than the account\'s', async () => {
  // Same NameID as Ada's linked identity, but the IdP now says it is someone else (a reused or renamed NameID).
  const rid = await startLogin();
  const r = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid, nameId: 'ada@acme.test', email: 'mallory@acme.test' }) } });
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /error=saml_email_mismatch/);
  assert.ok(!r.cookies.some((c) => c.name === 'nav_session'), 'no session');
  assert.equal(await db.one("SELECT 1 FROM users WHERE email = 'mallory@acme.test'"), null, 'no account was created or renamed');

  // Case differences alone are not drift.
  const rid2 = await startLogin();
  const ok = await call('POST', `/api/v1/auth/saml/${orgId}/acs`, { form: { SAMLResponse: idp.signedAssertionResponse({ requestId: rid2, nameId: 'ada@acme.test', email: 'Ada@Acme.test' }) } });
  assert.doesNotMatch(String(ok.headers.location), /error=/);
});
