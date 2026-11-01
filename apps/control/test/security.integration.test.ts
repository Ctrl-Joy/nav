// End to end hardening checks against a private PostgreSQL cluster (embedded-postgres binaries) on a spare port:
// second factors are single-use under concurrency, workflow fan-out is capped (429 from the API, failed attempt
// when suspending), queued workflow runs never stall deploy claims, pull requests from forks get no automatic
// previews and no secrets, and organization membership needs the invitee's consent.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});

const PG_PORT = Number(process.env.NAV_TEST_PG_PORT_SECURITY ?? (await freePort()));
const PASSWORD = 'navtest';
const WEBHOOK_SECRET = 'whsecret-test';
const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-security-test-'));
process.env.NAV_DATABASE_URL = `postgres://nav:${PASSWORD}@127.0.0.1:${PG_PORT}/postgres`;
process.env.NAV_MASTER_KEY ??= 'c'.repeat(64);
process.env.NAV_DATA_DIR = path.join(dir, 'nav');
process.env.NAV_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.NAV_WORKFLOW_MAX_ACTIVE_RUNS = '3';

const cluster = await import('../src/lib/pgcluster.ts');
const spec = { dataDir: path.join(dir, 'pg'), port: PG_PORT, superuser: 'nav', password: PASSWORD, listen: '127.0.0.1' };

let app: FastifyInstance;
let db: typeof import('../src/db/pool.ts');

before(async () => {
  await cluster.initCluster(spec);
  await cluster.startCluster(spec);
  db = await import('../src/db/pool.ts');
  await (await import('../src/db/migrate.ts')).migrate();
  app = await (await import('../src/http/app.ts')).buildApp();
});

after(async () => {
  await app?.close();
  await db?.pool.end();
  await cluster.stopCluster(spec.dataDir, 'immediate').catch(() => {});
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

type Res = { status: number; body: any };

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.cookie && method !== 'GET') headers['x-nav-csrf'] = '1';
  let payload: string | undefined = opts.raw;
  if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({ method: method as 'GET', url, headers, payload });
  let body: any = res.body;
  try { body = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.statusCode, body };
}

async function signup(email: string): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email, password: 'correct horse battery' }) });
  assert.equal(r.statusCode, 201, r.body);
  const cookie = `nav_session=${r.cookies.find((c) => c.name === 'nav_session')!.value}`;
  const me = (await call('GET', '/api/v1/auth/me', { cookie })).body;
  return { cookie, userId: me.user.id, workspaceId: me.workspaces[0].id };
}

let owner: Awaited<ReturnType<typeof signup>>;

test('setup', async () => {
  owner = await signup('owner@security.test');
});

test('in production the first account is not implicitly the instance administrator', async () => {
  const { config } = await import('@nav/shared/config');
  const { adminConfigWarning, isPlatformAdmin } = await import('../src/lib/providerSettings.ts');
  const before = { env: config.env, adminEmails: config.adminEmails };
  try {
    config.adminEmails = [];
    config.env = 'development';
    assert.equal(await isPlatformAdmin(owner.userId), true, 'outside production the first account administers the instance');
    assert.equal(adminConfigWarning(), null);
    config.env = 'production';
    assert.equal(await isPlatformAdmin(owner.userId), false, 'production needs NAV_ADMIN_EMAILS');
    assert.match(adminConfigWarning()!, /NAV_ADMIN_EMAILS/);
    config.adminEmails = ['owner@security.test'];
    assert.equal(adminConfigWarning(), null);
    assert.equal(await isPlatformAdmin(owner.userId), false, 'listed, but the address is not verified yet');
    await db.q('UPDATE users SET email_verified_at = now() WHERE id = $1', [owner.userId]);
    assert.equal(await isPlatformAdmin(owner.userId), true);
  } finally {
    Object.assign(config, before);
  }
});

// --- Second factors --------------------------------------------------------------------------------

test('an authenticator code and a recovery code each succeed once, even when used concurrently', async () => {
  const totp = await import('../src/lib/totp.ts');
  const { encrypt, sha256 } = await import('@nav/shared/crypto');
  const { checkSecondFactor } = await import('../src/http/routes/mfa.ts');
  const secret = totp.newSecret();
  const recovery = 'abcd-efgh-ijkl';
  await db.q('UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now(), totp_last_counter = NULL, recovery_codes = $3 WHERE id = $1',
    [owner.userId, encrypt(secret), JSON.stringify([sha256(recovery), sha256('other-code')])]);
  const user = (await db.one('SELECT * FROM users WHERE id = $1', [owner.userId]))!;
  const code = totp.codeAt(secret, Math.floor(Date.now() / 30_000));

  // The same user row (read before either request ran) for every attempt, as concurrent sign-ins would have.
  const totpResults = await Promise.all(Array.from({ length: 8 }, () => checkSecondFactor(user, code)));
  assert.equal(totpResults.filter((r) => r === 'totp').length, 1, `exactly one concurrent use of a code wins (${totpResults.join(',')})`);
  assert.equal(await checkSecondFactor(user, code), null, 'and it cannot be replayed later');

  const recoveryResults = await Promise.all(Array.from({ length: 8 }, () => checkSecondFactor(user, recovery)));
  assert.equal(recoveryResults.filter((r) => r === 'recovery').length, 1, `exactly one concurrent use of a recovery code wins (${recoveryResults.join(',')})`);
  const left = (await db.one('SELECT recovery_codes FROM users WHERE id = $1', [owner.userId]))!.recovery_codes;
  assert.deepEqual(left, [sha256('other-code')], 'only the used recovery code is gone');
  await db.q('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, recovery_codes = $2 WHERE id = $1', [owner.userId, '[]']);
});

// --- Workflows ---------------------------------------------------------------------------------------

async function workflowService(name: string, concurrency = 10): Promise<{ id: string; deployId: string }> {
  const id = `srv_${name}`;
  await db.q(
    `INSERT INTO services (id, workspace_id, name, slug, type, runtime, repo_url, branch, deploy_hook_token, workflow_concurrency)
     VALUES ($1,$2,$3,$4,'workflow','node','https://github.com/acme/jobs','main','tok',$5)`,
    [id, owner.workspaceId, name, `${name}-${owner.workspaceId.slice(-6)}`.toLowerCase(), concurrency],
  );
  const deployId = `dep_${name}`;
  await db.q("INSERT INTO deploys (id, service_id, status, trigger) VALUES ($1,$2,'live','manual')", [deployId, id]);
  await db.q('UPDATE services SET current_deploy_id = $2 WHERE id = $1', [id, deployId]);
  await db.q("INSERT INTO workflow_tasks (deploy_id, service_id, name) VALUES ($1,$2,'work')", [deployId, id]);
  return { id, deployId };
}

test('active workflow runs are capped per workflow: the API answers 429 and fan-out fails the attempt', async () => {
  const wf = await workflowService('capped');
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', `/api/v1/workflows/${wf.id}/tasks/work/runs`, { cookie: owner.cookie, body: { input: i } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const over = await call('POST', `/api/v1/workflows/${wf.id}/tasks/work/runs`, { cookie: owner.cookie, body: { input: 'x' } });
  assert.equal(over.status, 429, JSON.stringify(over.body));
  assert.equal(over.body.error?.code ?? over.body.code, 'run_limit');

  // A running run that tries to fan out past the limit records nothing and fails its attempt.
  const svc = (await db.one('SELECT * FROM services WHERE id = $1', [wf.id]))!;
  const run = (await db.one("UPDATE workflow_runs SET status = 'running', attempts = 1, started_at = now() WHERE id = (SELECT id FROM workflow_runs WHERE service_id = $1 ORDER BY created_at LIMIT 1) RETURNING *", [wf.id]))!;
  const { suspend } = await import('../src/agent/workflows.ts');
  const lines: string[] = [];
  await suspend(run, svc, [1, 2, 3].map((seq) => ({ seq, kind: 'run', task: 'work', input: seq })), (l) => lines.push(l));
  assert.equal((await db.one('SELECT count(*)::int AS n FROM workflow_runs WHERE parent_run_id = $1', [run.id]))!.n, 0, 'no child runs were created');
  assert.equal((await db.one('SELECT count(*)::int AS n FROM workflow_steps WHERE run_id = $1', [run.id]))!.n, 0);
  assert.equal((await db.one('SELECT status FROM workflow_runs WHERE id = $1', [run.id]))!.status, 'failed', 'the attempt failed (no retries configured)');
  assert.ok(lines.some((l) => /could not start subtasks/.test(l)), lines.join('\n'));

  // With room again, an idempotent repeat still returns the first run rather than a 429.
  const keyed = await call('POST', `/api/v1/workflows/${wf.id}/tasks/work/runs`, { cookie: owner.cookie, body: { input: 1, idempotencyKey: 'k1' } });
  assert.equal(keyed.status, 201, JSON.stringify(keyed.body));
  const again = await call('POST', `/api/v1/workflows/${wf.id}/tasks/work/runs`, { cookie: owner.cookie, body: { input: 1, idempotencyKey: 'k1' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  await db.q("UPDATE workflow_runs SET status = 'canceled' WHERE service_id = $1", [wf.id]);

  // The workspace-wide limit spans workflows.
  process.env.NAV_WORKSPACE_MAX_ACTIVE_RUNS = '1';
  try {
    const other = await workflowService('other');
    assert.equal((await call('POST', `/api/v1/workflows/${wf.id}/tasks/work/runs`, { cookie: owner.cookie, body: {} })).status, 201);
    const ws = await call('POST', `/api/v1/workflows/${other.id}/tasks/work/runs`, { cookie: owner.cookie, body: {} });
    assert.equal(ws.status, 429);
    assert.match(JSON.stringify(ws.body), /workspace/);
  } finally {
    delete process.env.NAV_WORKSPACE_MAX_ACTIVE_RUNS;
  }
  await db.q("UPDATE workflow_runs SET status = 'canceled'");
  await db.q('DELETE FROM jobs');
});

test('thousands of queued runs of a saturated workflow do not slow down claiming a deploy', async () => {
  const { claim } = await import('../src/agent/queue.ts');
  const busy = await workflowService('busy', 1);
  const free = await workflowService('free', 5);
  await db.q("INSERT INTO jobs (kind, payload, status, locked_by, locked_at) VALUES ('workflow_run', $1, 'running', 'node_q', now())", [{ runId: 'wfr_running', serviceId: busy.id }]);
  await db.q("INSERT INTO jobs (kind, payload) SELECT 'workflow_run', jsonb_build_object('runId', 'wfr_' || g, 'serviceId', $1::text) FROM generate_series(1, 5000) g", [busy.id]);
  await db.q("INSERT INTO jobs (kind, payload, concurrency_key) VALUES ('deploy', $1, $2)", [{ deployId: 'dep_x', serviceId: 'srv_x' }, 'svc:srv_x']);
  await db.q("INSERT INTO jobs (kind, payload) VALUES ('workflow_run', $1)", [{ runId: 'wfr_free', serviceId: free.id }]);
  await db.q('ANALYZE jobs');

  let t = performance.now();
  const deploy = await claim('node_q', 'work', false);
  const deployMs = performance.now() - t;
  assert.equal(deploy?.kind, 'deploy');
  assert.ok(deployMs < 1000, `deploy claimed in ${deployMs.toFixed(0)}ms`);

  t = performance.now();
  const wf = await claim('node_q', 'workflow', false);
  const wfMs = performance.now() - t;
  assert.equal(wf?.payload.serviceId, free.id, 'the saturated workflow is skipped, the free one is claimed');
  assert.ok(wfMs < 1000, `workflow lane answered in ${wfMs.toFixed(0)}ms`);
  t = performance.now();
  assert.equal(await claim('node_q', 'workflow', false), null, 'nothing else is runnable');
  assert.ok(performance.now() - t < 1000);

  // Every claim holds the global queue lock: a burst of workflow claims must not hold up deploys either.
  await db.q("INSERT INTO jobs (kind, payload, concurrency_key) VALUES ('deploy', $1, $2)", [{ deployId: 'dep_y', serviceId: 'srv_y' }, 'svc:srv_y']);
  t = performance.now();
  const [d2] = await Promise.all([claim('node_q', 'work', false), ...Array.from({ length: 10 }, () => claim('node_q', 'workflow', false))]);
  assert.equal(d2?.kind, 'deploy');
  assert.ok(performance.now() - t < 3000, `deploy claimed alongside 10 workflow claims in ${(performance.now() - t).toFixed(0)}ms`);
  await db.q('DELETE FROM jobs');
});

// --- Pull request previews ------------------------------------------------------------------------------

async function webhook(event: string, body: unknown): Promise<Res> {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;
  return call('POST', '/api/v1/webhooks/github', { raw, headers: { 'x-github-event': event, 'x-hub-signature-256': sig } });
}

const prEvent = (action: string, number: number, headRepo: string, label?: string) => ({
  action,
  number,
  ...(label ? { label: { name: label } } : {}),
  repository: { html_url: 'https://github.com/acme/app', full_name: 'acme/app' },
  pull_request: {
    number,
    title: `PR ${number}`,
    labels: label ? [{ name: label }] : [],
    head: { ref: `feature-${number}`, sha: `${number}`.padStart(40, 'a'), repo: { full_name: headRepo } },
    base: { ref: 'main', repo: { full_name: 'acme/app' } },
  },
});

test('fork pull requests get no automatic preview, and a maintainer-labeled one gets no secrets', async () => {
  const parentId = 'srv_parentweb';
  await db.q(
    `INSERT INTO services (id, workspace_id, name, slug, type, runtime, repo_url, branch, deploy_hook_token, previews)
     VALUES ($1,$2,'web','web-sec','web','node','https://github.com/acme/app','main','tok','{"mode":"automatic","expireAfterDays":7}')`,
    [parentId, owner.workspaceId],
  );
  const env = await import('../src/lib/env.ts');
  await db.tx((c) => env.replaceEnv(c, 'service', parentId, [{ key: 'DATABASE_PASSWORD', value: 'prod-secret' }]));
  await db.tx((c) => env.replaceFiles(c, 'service', parentId, [{ filename: 'key.pem', content: 'PRIVATE' }]));
  const group = (await db.one("INSERT INTO env_groups (id, workspace_id, name) VALUES ('evg_sec', $1, 'shared') RETURNING id", [owner.workspaceId]))!;
  await db.q('INSERT INTO service_env_groups (service_id, group_id) VALUES ($1,$2)', [parentId, group.id]);

  // Same-repository PR: automatic preview with the parent's environment, as before.
  assert.equal((await webhook('pull_request', prEvent('opened', 1, 'acme/app'))).status, 200);
  const same = (await db.one('SELECT * FROM services WHERE parent_service_id = $1 AND pr_number = 1', [parentId]))!;
  assert.ok((await env.listEnv('service', same.id)).some((e) => e.key === 'DATABASE_PASSWORD'));
  assert.equal(same.untrusted, false);

  // Fork PR: skipped, with an event saying why.
  assert.equal((await webhook('pull_request', prEvent('opened', 2, 'mallory/app'))).status, 200);
  assert.equal(await db.one('SELECT 1 FROM services WHERE parent_service_id = $1 AND pr_number = 2', [parentId]), null, 'no automatic preview for a fork');
  const skipped = await db.one("SELECT data FROM events WHERE kind = 'preview_skipped' AND service_id = $1 ORDER BY id DESC LIMIT 1", [parentId]);
  assert.equal(skipped?.data.prNumber, 2);
  assert.match(skipped?.data.reason, /fork/);
  // Even a label already on the PR does not deploy on a push (synchronize): only the act of labeling does.
  assert.equal((await webhook('pull_request', { ...prEvent('synchronize', 2, 'mallory/app'), pull_request: { ...prEvent('synchronize', 2, 'mallory/app').pull_request, labels: [{ name: 'nav-preview' }] } })).status, 200);
  assert.equal(await db.one('SELECT 1 FROM services WHERE parent_service_id = $1 AND pr_number = 2', [parentId]), null);

  // A maintainer adds nav-preview: the preview is created with an empty environment.
  assert.equal((await webhook('pull_request', prEvent('labeled', 2, 'mallory/app', 'nav-preview'))).status, 200);
  const fork = (await db.one('SELECT * FROM services WHERE parent_service_id = $1 AND pr_number = 2', [parentId]))!;
  assert.equal(fork.untrusted, true);
  assert.deepEqual((await env.listEnv('service', fork.id)).map((e) => e.key), ['IS_PULL_REQUEST']);
  assert.deepEqual(await env.listFiles('service', fork.id), []);
  assert.equal((await db.q('SELECT 1 FROM service_env_groups WHERE service_id = $1', [fork.id])).length, 0);

  // Preview services (fork or not) never get the workflows token; ordinary services do.
  const { InstanceManager } = await import('../src/agent/instances.ts');
  const im = new InstanceManager({} as never, 'node_sec');
  const deploy = { id: 'dep_sec', commit_sha: null, branch: 'main' };
  const forkEnv = (await im.runtimeEnv(fork, deploy, null)).env;
  assert.equal(forkEnv.NAV_WORKFLOWS_TOKEN, undefined);
  assert.equal(forkEnv.DATABASE_PASSWORD, undefined);
  assert.equal(forkEnv.NAV_SERVICE_ID, fork.id, 'platform NAV_* variables are still there');
  assert.equal((await im.runtimeEnv(same, deploy, null)).env.NAV_WORKFLOWS_TOKEN, undefined);
  const parent = (await db.one('SELECT * FROM services WHERE id = $1', [parentId]))!;
  assert.match((await im.runtimeEnv(parent, deploy, null)).env.NAV_WORKFLOWS_TOKEN, /^navwf_/);
});

// --- Organization invitations ------------------------------------------------------------------------

test('adding an org member sends an invitation the invitee must accept; the answer never reveals accounts', async () => {
  const org = await call('POST', '/api/v1/orgs', { cookie: owner.cookie, body: { name: 'Acme Security' } });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  const orgId = org.body.id;
  const bob = await signup('bob@security.test');

  const existing = await call('POST', `/api/v1/orgs/${orgId}/members`, { cookie: owner.cookie, body: { email: 'bob@security.test', role: 'admin' } });
  const missing = await call('POST', `/api/v1/orgs/${orgId}/members`, { cookie: owner.cookie, body: { email: 'nobody@security.test', role: 'admin' } });
  assert.equal(existing.status, 202);
  assert.equal(missing.status, 202);
  assert.deepEqual(Object.keys(existing.body.invite).sort(), Object.keys(missing.body.invite).sort(), 'same shape whether or not the account exists');
  assert.equal(await db.one('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, bob.userId]), null, 'not a member before accepting');
  const listed = await call('GET', `/api/v1/orgs/${orgId}/members`, { cookie: owner.cookie });
  assert.deepEqual(listed.body.invites.map((i: any) => i.email).sort(), ['bob@security.test', 'nobody@security.test']);

  // Unverified addresses cannot see or accept invitations (anyone can sign up with any address).
  assert.deepEqual((await call('GET', '/api/v1/org-invites', { cookie: bob.cookie })).body.items, []);
  assert.equal((await call('POST', `/api/v1/org-invites/${existing.body.invite.id}/accept`, { cookie: bob.cookie, body: {} })).status, 403);
  await db.q('UPDATE users SET email_verified_at = now() WHERE id = $1', [bob.userId]);

  // Someone else cannot accept Bob's invitation.
  const eve = await signup('eve@security.test');
  await db.q('UPDATE users SET email_verified_at = now() WHERE id = $1', [eve.userId]);
  assert.equal((await call('POST', `/api/v1/org-invites/${existing.body.invite.id}/accept`, { cookie: eve.cookie, body: {} })).status, 404);

  const mine = await call('GET', '/api/v1/org-invites', { cookie: bob.cookie });
  assert.equal(mine.body.items.length, 1);
  assert.equal(mine.body.items[0].orgName, 'Acme Security');
  const accepted = await call('POST', `/api/v1/org-invites/${mine.body.items[0].id}/accept`, { cookie: bob.cookie, body: {} });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await db.one('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, bob.userId]))?.role, 'admin');
  assert.equal((await call('POST', `/api/v1/org-invites/${mine.body.items[0].id}/accept`, { cookie: bob.cookie, body: {} })).status, 404, 'single use');

  // Declining removes the invitation without joining.
  await call('POST', `/api/v1/orgs/${orgId}/members`, { cookie: owner.cookie, body: { email: 'eve@security.test' } });
  const eveInvite = (await call('GET', '/api/v1/org-invites', { cookie: eve.cookie })).body.items[0];
  assert.equal((await call('POST', `/api/v1/org-invites/${eveInvite.id}/decline`, { cookie: eve.cookie, body: {} })).status, 204);
  assert.equal(await db.one('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, eve.userId]), null);

  // Inviting is rate limited.
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    limited = (await call('POST', `/api/v1/orgs/${orgId}/members`, { cookie: owner.cookie, body: { email: `x${i}@security.test` } })).status === 429;
  }
  assert.ok(limited, 'invitations are rate limited');
});
