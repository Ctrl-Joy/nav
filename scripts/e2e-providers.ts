// End-to-end check of the sign-in providers admin page API against a running stack started with
// NAV_ADMIN_EMAILS=nav-admin@nav.test: only a verified admin can manage providers, secrets never come back,
// saving turns a provider on immediately, deleting turns it off.
// Usage: node scripts/e2e-providers.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const ADMIN = process.env.NAV_ADMIN_EMAIL ?? 'nav-admin@nav.test';
const LOG = path.resolve('.nav', 'dev.log');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: boolean[] = [];
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

function client() {
  const jar = new Map<string, string>();
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(API + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-nav-csrf': '1', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const t = await res.text();
    let data: any = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
    return { status: res.status, data, location: res.headers.get('location') };
  };
}
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); } catch (e) { results.push(false); console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const admin = client();
const pw = 'admin-pass-123456';

await step('the configured admin email becomes an admin only once verified', async () => {
  let r = await admin('POST', '/auth/signup', { email: ADMIN, password: pw });
  if (r.status === 409) r = await admin('POST', '/auth/login', { email: ADMIN, password: pw });
  assert(r.status === 200 || r.status === 201, `sign in ${r.status} ${JSON.stringify(r.data)}`);
  const me = await admin('GET', '/auth/me');
  if (!me.data.user.emailVerified) {
    assert(me.data.user.isPlatformAdmin === false, 'an unverified address must not be admin');
    assert((await admin('GET', '/admin/auth-providers')).status === 403, 'unverified: 403');
    await admin('POST', '/auth/password/forgot', { email: ADMIN });
    let token = '';
    for (let i = 0; i < 20 && !token; i++) {
      token = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`password reset requested for ${ADMIN}:`)).at(-1)?.match(/token=([\w-]+)/)?.[1] ?? '';
      if (!token) await sleep(250);
    }
    assert(token, 'reset link in the log');
    assert((await admin('POST', '/auth/password/reset', { token, password: pw })).status === 200, 'reset (verifies the email)');
  }
  const me2 = await admin('GET', '/auth/me');
  assert(me2.data.user.isPlatformAdmin === true, `verified admin: ${JSON.stringify(me2.data.user)}`);
});

await step('non-admins and signed-out callers cannot see or change providers', async () => {
  const other = client();
  await other('POST', '/auth/signup', { email: `not-admin-${Date.now()}@nav.test`, password: pw });
  assert((await other('GET', '/admin/auth-providers')).status === 403, 'non-admin 403');
  assert((await other('PUT', '/admin/auth-providers/google', { clientId: 'x', clientSecret: 'y' })).status === 403, 'non-admin PUT 403');
  assert((await client()('GET', '/admin/auth-providers')).status === 401, 'signed out 401');
});

await step('saving Google turns its button on now; the secret never comes back; delete turns it off', async () => {
  const id = `1234567890-navtest${Date.now()}.apps.googleusercontent.com`;
  const put = await admin('PUT', '/admin/auth-providers/google', { clientId: id, clientSecret: 'GOCSPX-super-secret-value' });
  assert(put.status === 200, `save ${put.status} ${JSON.stringify(put.data)}`);
  const list = await admin('GET', '/admin/auth-providers');
  assert(!JSON.stringify(list.data).includes('super-secret'), 'secret must never be returned');
  const cfg = await client()('GET', '/config');
  assert(cfg.data.auth.providers.google === true, `google enabled: ${JSON.stringify(cfg.data.auth.providers)}`);
  const start = await client()('GET', '/auth/oauth/google/start');
  const u = new URL(start.location ?? 'http://x');
  assert(u.host === 'accounts.google.com' && u.searchParams.get('client_id') === id && u.searchParams.get('code_challenge_method') === 'S256', `start redirects to Google with the saved id: ${start.location}`);
  assert((await admin('DELETE', '/admin/auth-providers/google')).status < 300, 'delete');
  const cfg2 = await client()('GET', '/config');
  assert(cfg2.data.auth.providers.google === false, 'google off again');
  const off = await client()('GET', '/auth/oauth/google/start');
  assert(off.location?.includes('error=provider_disabled'), 'disabled provider cannot start');
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
