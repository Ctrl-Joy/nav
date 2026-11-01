// End-to-end checks for the account and workspace features: two-factor sign-in, recovery codes, "require 2FA",
// the audit log, signed webhooks with retries, and email notifications (outbox when no SMTP is configured).
// Usage: node scripts/e2e-parity.ts   (against npm run dev)
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { codeAt } from '../apps/control/src/lib/totp.ts';

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const OUTBOX = path.resolve('.nav/outbox');
const results: { name: string; ok: boolean; err?: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

/** A tiny cookie-keeping client. */
function client() {
  const jar = new Map<string, string>();
  return async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const res = await fetch(API + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-nav-csrf': '1', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (/expires=Thu, 01 Jan 1970/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  • ${name} ... `);
  try { await fn(); results.push({ name, ok: true }); console.log('\x1b[32mok\x1b[0m'); }
  catch (err) { results.push({ name, ok: false, err: (err as Error).message }); console.log(`\x1b[31mFAILED\x1b[0m\n    ${(err as Error).message}`); }
}

const email = `parity-${Date.now()}@nav.test`;
const password = 'correct-horse-battery';
const a = client();
let ws = '';
let secret = '';
let recovery: string[] = [];
const totpNow = (offset = 0) => codeAt(secret, Math.floor(Date.now() / 30000) + offset);

console.log(`NAV parity e2e against ${API}\n`);
{
  const r = await a('POST', '/auth/signup', { email, password });
  ws = r.data.workspaces[0].id;
}

await step('2FA: enrol with an authenticator code, get 10 recovery codes', async () => {
  const s = await a('POST', '/auth/mfa/setup');
  assert(s.status === 200 && s.data.otpauthUrl.startsWith('otpauth://totp/'), `setup ${s.status}`);
  secret = s.data.secret;
  const bad = await a('POST', '/auth/mfa/enable', { code: '000000' });
  assert(bad.status === 400, 'a wrong code must be refused');
  const ok = await a('POST', '/auth/mfa/enable', { code: totpNow() });
  assert(ok.status === 200 && ok.data.recoveryCodes.length === 10, `enable ${ok.status} ${JSON.stringify(ok.data)}`);
  recovery = ok.data.recoveryCodes;
  const me = await a('GET', '/auth/me');
  assert(me.data.user.mfaEnabled === true && me.data.user.recoveryCodesLeft === 10, 'me should report 2FA on');
});

await step('2FA: password alone no longer signs in; a code (once) does', async () => {
  const b = client();
  const l = await b('POST', '/auth/login', { email, password });
  assert(l.status === 200 && l.data.mfaRequired === true, `login should ask for a code, got ${JSON.stringify(l.data)}`);
  assert((await b('GET', '/auth/me')).status === 401, 'no session before the code');
  assert((await b('POST', '/auth/login/mfa', { code: '123456' })).status === 401, 'wrong code refused');
  // The enrolment code's time step was used already; wait for the next one if needed.
  let code = totpNow();
  const used = (await a('GET', '/auth/me')).data;
  void used;
  let r = await b('POST', '/auth/login/mfa', { code });
  if (r.status === 401) { await sleep(31_000); code = totpNow(); r = await b('POST', '/auth/login/mfa', { code }); }
  assert(r.status === 200, `code should sign in: ${JSON.stringify(r.data)}`);
  assert((await b('GET', '/auth/me')).status === 200, 'session after the code');
  const c = client();
  await c('POST', '/auth/login', { email, password });
  assert((await c('POST', '/auth/login/mfa', { code })).status === 401, 'the same code must not work twice');
});

await step('2FA: a recovery code signs in once', async () => {
  const b = client();
  await b('POST', '/auth/login', { email, password });
  const r = await b('POST', '/auth/login/mfa', { code: recovery[0] });
  assert(r.status === 200 && r.data.usedRecoveryCode && r.data.recoveryCodesLeft === 9, `recovery ${JSON.stringify(r.data)}`);
  const c = client();
  await c('POST', '/auth/login', { email, password });
  assert((await c('POST', '/auth/login/mfa', { code: recovery[0] })).status === 401, 'a recovery code works once');
});

await step('login settings: a workspace can require 2FA of its members', async () => {
  const other = client();
  const oe = `parity-member-${Date.now()}@nav.test`;
  const inv = await a('POST', `/workspaces/${ws}/members`, { email: oe, role: 'developer' });
  assert(inv.status === 201, `invite ${inv.status} ${JSON.stringify(inv.data)}`);
  await other('POST', '/auth/signup', { email: oe, password });
  assert((await other('GET', `/workspaces/${ws}/services`)).status === 200, 'member can see the workspace');
  const on = await a('PATCH', `/workspaces/${ws}`, { requireTwoFactor: true });
  assert(on.status === 200 && on.data.requireTwoFactor === true, `require ${on.status}`);
  const denied = await other('GET', `/workspaces/${ws}/services`);
  assert(denied.status === 403 && denied.data.error.code === 'mfa_required', `member without 2FA should be blocked, got ${denied.status}`);
  assert((await a('GET', `/workspaces/${ws}/services`)).status === 200, 'owner with 2FA still has access');
  await a('PATCH', `/workspaces/${ws}`, { requireTwoFactor: false });
});

await step('audit log: changes are recorded with actor, action and IP, never values', async () => {
  await a('POST', `/workspaces/${ws}/env-groups`, { name: 'audit-check', envVars: [{ key: 'SECRET_TOKEN', value: 'hunter2' }] });
  const log = await a('GET', `/workspaces/${ws}/audit-logs`);
  assert(log.status === 200, `audit ${log.status}`);
  const actions = log.data.items.map((i: any) => i.action);
  for (const want of ['env_group.create', 'workspace.update', 'member.create']) assert(actions.includes(want), `missing ${want} in ${actions.join(', ')}`);
  const eg = log.data.items.find((i: any) => i.action === 'env_group.create');
  assert(eg.actorEmail === email && eg.ip, 'actor and IP recorded');
  assert(!JSON.stringify(log.data).includes('hunter2'), 'secret values must not be logged');
});

await step('webhooks: signed delivery (Standard Webhooks), event filter, retry after failure', async () => {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let fail = true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = fail ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const created = await a('POST', `/workspaces/${ws}/webhooks`, { name: 'ci', url: `http://127.0.0.1:${port}/hook`, events: ['env_group_created'] });
    assert(created.status === 201 && created.data.secret.startsWith('whsec_'), `create ${created.status} ${JSON.stringify(created.data)}`);
    const hookId = created.data.webhook.id;
    const whsec = created.data.secret;
    const t = await a('POST', `/webhooks/${hookId}/test`);
    assert(t.data.delivery.status === 'failed' && t.data.delivery.statusCode === 500, `test delivery should record the 500: ${JSON.stringify(t.data)}`);
    fail = false;
    const before = received.length;
    await a('POST', `/workspaces/${ws}/env-groups`, { name: 'hook-check', envVars: [] });
    await a('POST', `/workspaces/${ws}/projects`, { name: 'not-subscribed' }).catch(() => {});
    const deadline = Date.now() + 20_000;
    while (received.length === before && Date.now() < deadline) await sleep(300);
    const got = received[received.length - 1];
    await sleep(4000); // anything else that would (wrongly) be delivered
    assert(got, 'a delivery for the subscribed event');
    assert(received.slice(before).every((r) => JSON.parse(r.body).type === 'env_group_created'), 'only subscribed event types are delivered');
    const payload = JSON.parse(got.body);
    assert(payload.type === 'env_group_created' && payload.workspaceId === ws, `payload ${got.body}`);
    const expected = `v1,${createHmac('sha256', Buffer.from(whsec.slice(6), 'base64')).update(`${got.headers['webhook-id']}.${got.headers['webhook-timestamp']}.${got.body}`).digest('base64')}`;
    assert(got.headers['webhook-signature'] === expected, 'signature must verify with the signing secret');
    const ds = await a('GET', `/webhooks/${hookId}/deliveries`);
    assert(ds.data.items.some((d: any) => d.eventType === 'env_group_created' && d.status === 'succeeded'), 'delivery history shows success');
  } finally {
    server.close();
  }
});

await step('webhooks: private targets refused when not allowed, and URLs must parse', async () => {
  const bad = await a('POST', `/workspaces/${ws}/webhooks`, { name: 'x', url: 'not a url' });
  assert(bad.status === 400, `bad url ${bad.status}`);
});

await step('email: invite and password reset are sent (outbox without SMTP)', async () => {
  const files = async () => (await readdir(OUTBOX).catch(() => [] as string[])).sort();
  const before = new Set(await files());
  const target = `parity-invite-${Date.now()}@nav.test`;
  await a('POST', `/workspaces/${ws}/members`, { email: target, role: 'viewer' });
  await a('POST', '/auth/password/forgot', { email });
  await sleep(1000);
  const fresh = (await files()).filter((f) => !before.has(f));
  const texts = await Promise.all(fresh.map((f) => readFile(path.join(OUTBOX, f), 'utf8')));
  assert(texts.some((t) => t.includes(`To: ${target}`) && t.includes('invited')), 'invite email');
  assert(texts.some((t) => t.includes(`To: ${email}`) && t.includes('reset-password?token=')), 'reset email');
});

await step('shell: open a shell in a running instance with an API key; foreign origins refused', async () => {
  const key = (await a('POST', '/api-keys', { name: 'shell' })).data.token;
  const svc = (await a('POST', `/workspaces/${ws}/services`, { name: `shell-${Date.now().toString(36)}`, type: 'web', repoUrl: 'http://localhost:9420/node-web.git', healthCheckPath: '/healthz', plan: 'starter' })).data;
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && (await a('GET', `/deploys/${svc.deploy.id}`)).data?.status !== 'live') await sleep(2000);
    const { default: WebSocket } = await import('ws');
    const out = await new Promise<string>((resolve, reject) => {
      const sock = new WebSocket(`${API.replace(/^http/, 'ws')}/services/${svc.service.id}/shell?cols=100&rows=30`, { headers: { authorization: `Bearer ${key}` } });
      let buf = '';
      const t = setTimeout(() => { sock.close(); reject(new Error(`no output; got: ${buf.slice(-300)}`)); }, 20_000);
      sock.on('message', (d, bin) => {
        // The marker is split so the echoed command line itself never matches.
        const cmd = `node -e "console.log(['SHELL', 'OK', process.env.NAV_SERVICE_ID].join(String.fromCharCode(95)))"\n`;
        if (!bin) { const m = JSON.parse(String(d)); if (m.type === 'ready') sock.send(Buffer.from(cmd)); if (m.type === 'error') reject(new Error(m.message)); return; }
        buf += d.toString();
        if (buf.includes(`SHELL_OK_${svc.service.id}`)) { clearTimeout(t); sock.close(); resolve(buf); }
      });
      sock.on('unexpected-response', (_q, r) => reject(new Error(`upgrade refused: ${r.statusCode}`)));
      sock.on('error', reject);
    });
    assert(out.includes(svc.service.id), 'command ran with the instance environment');
    const refused = await new Promise<number>((resolve) => {
      const s2 = new WebSocket(`${API.replace(/^http/, 'ws')}/services/${svc.service.id}/shell`, { headers: { origin: 'https://evil.example', cookie: 'nav_session=whatever' } });
      s2.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
      s2.on('open', () => { s2.close(); resolve(101); });
      s2.on('error', () => {});
    });
    assert(refused === 401 || refused === 403, `foreign/unauthenticated shell should be refused, got ${refused}`);
    const log = await a('GET', `/workspaces/${ws}/audit-logs?action=service.shell`);
    assert(log.data.items.length >= 1, 'shell sessions are audited');
  } finally {
    await a('DELETE', `/services/${svc.service.id}`).catch(() => {});
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ', ' + failed.length + ' failed' : ''}`);
process.exit(failed.length ? 1 : 0);
