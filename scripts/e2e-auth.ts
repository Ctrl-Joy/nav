// End-to-end test of NAV's sign-in flows against a running stack.
// Covers email + password, password reset, account settings endpoints and the OAuth/OIDC path (state cookie, PKCE,
// token exchange, userinfo, account linking) using a mock OpenID provider this script runs on localhost.
// The control plane must be started with:
//   NAV_SSO_ISSUER=http://localhost:9431 NAV_SSO_CLIENT_ID=nav-test NAV_SSO_CLIENT_SECRET=nav-test-secret NAV_SSO_DOMAINS=sso.test
//   NAV_GITLAB_URL=http://localhost:9431 NAV_GITLAB_CLIENT_ID=nav-test NAV_GITLAB_CLIENT_SECRET=nav-test-secret
// (the mock also plays GitLab; Bitbucket must be left unconfigured)
// Usage: node scripts/e2e-auth.ts
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const API = process.env.NAV_API ?? 'http://localhost:4000/api/v1';
const IDP_PORT = 9431;
const IDP = `http://localhost:${IDP_PORT}`;
const CLIENT = { id: 'nav-test', secret: 'nav-test-secret' };
const LOG = path.resolve(process.env.NAV_DATA_DIR ?? '.nav', 'dev.log');
const run = randomBytes(3).toString('hex');

// ---- Mock OpenID provider ----
const codes = new Map<string, { challenge: string; email: string; redirect: string }>();
const tokens = new Map<string, string>();
let idpTokenCalls = 0;
const idp = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', IDP);
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(200, { issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, userinfo_endpoint: `${IDP}/userinfo` });
  }
  if (url.pathname === '/authorize' || url.pathname === '/oauth/authorize') {
    const q = url.searchParams;
    if (q.get('client_id') !== CLIENT.id || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return json(400, { error: 'invalid_request' });
    const code = randomBytes(12).toString('hex');
    codes.set(code, { challenge: q.get('code_challenge')!, email: q.get('login_hint') ?? 'nobody@sso.test', redirect: q.get('redirect_uri')! });
    const back = new URL(q.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state')!);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if ((url.pathname === '/token' || url.pathname === '/oauth/token') && req.method === 'POST') {
    idpTokenCalls++;
    let body = '';
    for await (const c of req) body += c;
    const f = new URLSearchParams(body);
    const entry = codes.get(f.get('code') ?? '');
    codes.delete(f.get('code') ?? '');
    const pkceOk = entry && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === entry.challenge;
    if (!entry || !pkceOk || f.get('client_id') !== CLIENT.id || f.get('client_secret') !== CLIENT.secret || f.get('redirect_uri') !== entry.redirect) {
      return json(400, { error: 'invalid_grant' });
    }
    const tok = randomBytes(16).toString('hex');
    tokens.set(tok, entry.email);
    return json(200, { access_token: tok, token_type: 'Bearer' });
  }
  if (url.pathname === '/api/v4/user') {
    const email = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!email) return json(401, { message: '401 Unauthorized' });
    // Addresses starting with "unconfirmed" have never been confirmed on this GitLab.
    return json(200, { id: Number.parseInt(createHash('sha256').update(email).digest('hex').slice(0, 8), 16), username: email.split('@')[0], name: email.split('@')[0], email, confirmed_at: email.startsWith('unconfirmed') ? null : '2026-01-01T00:00:00Z' });
  }
  if (url.pathname === '/userinfo') {
    const email = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!email) return json(401, { error: 'invalid_token' });
    return json(200, { sub: `sub-${email}`, email, email_verified: true, name: email.split('@')[0] });
  }
  json(404, { error: 'not_found' });
});

// ---- Tiny cookie-jar client ----
class Browser {
  jar = new Map<string, string>();
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (!v || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      redirect: 'manual',
      headers: { cookie: this.cookieHeader(), 'x-nav-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.store(res);
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, location: res.headers.get('location') };
  }
  /** OAuth round trip through the GitLab provider (start → mock GitLab → callback). */
  async gitlab(email: string, opts: { dropStateCookie?: boolean; replayCode?: boolean } = {}) {
    const s = await this.req('GET', `/auth/oauth/gitlab/start?login_hint=${encodeURIComponent(email)}`);
    assert(s.status === 302 && s.location?.startsWith(`${IDP}/oauth/authorize`), `start should redirect to GitLab, got ${s.status} ${s.location}`);
    const auth = new URL(s.location!);
    assert(auth.searchParams.get('code_challenge_method') === 'S256' && auth.searchParams.get('state'), 'PKCE and state are sent');
    const a = await this.req('GET', s.location!);
    if (opts.dropStateCookie) this.jar.delete('nav_oauth');
    const done = await this.req('GET', a.location!);
    if (opts.replayCode) {
      // A stolen callback URL replayed by someone else: no state cookie, and the code was already spent.
      const thief = new Browser();
      const again = await thief.req('GET', a.location!);
      return { done, final: done.location ?? '', replay: again.location ?? '', thief };
    }
    return { done, final: done.location ?? '' };
  }

  /** Runs an OAuth round trip: API start → IdP authorize → API callback. Returns the final dashboard redirect. */
  async sso(email: string, opts: { tamperState?: boolean; mode?: 'connect' } = {}) {
    const lookup = await this.req('POST', '/auth/sso', { email });
    if (lookup.status !== 200) return { lookup };
    let start = new URL(lookup.data.redirect, API);
    if (opts.mode) start.searchParams.set('mode', opts.mode);
    const s = await this.req('GET', start.toString());
    assert(s.status === 302 && s.location?.startsWith(`${IDP}/authorize`), `start should redirect to the IdP, got ${s.status} ${s.location}`);
    const a = await this.req('GET', s.location!);
    let cb = a.location!;
    if (opts.tamperState) { const u = new URL(cb); u.searchParams.set('state', 'forged'); cb = u.toString(); }
    const done = await this.req('GET', cb);
    return { done, final: done.location ?? '' };
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const results: { name: string; ok: boolean; err?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${Date.now() - t}ms)\x1b[0m`);
  } catch (e) {
    results.push({ name, ok: false, err: (e as Error).message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).message}`);
  }
}

async function resetLinkFor(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`password reset requested for ${email}:`));
    const m = lines.at(-1)?.match(/reset-password\?token=([\w-]+)/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no reset link for ${email} in ${LOG}`);
}

await new Promise<void>((r) => idp.listen(IDP_PORT, '127.0.0.1', r));
console.log(`\nNAV auth e2e — run ${run}\n`);

const pw = `pw-${randomBytes(6).toString('hex')}`;
const dana = new Browser();
const danaEmail = `dana.${run}@nav.test`;

await step('config advertises enabled providers', async () => {
  const r = await dana.req('GET', '/config');
  assert(r.data.auth?.providers?.sso === true, 'SSO should be enabled (start control with the NAV_SSO_* variables)');
  assert(typeof r.data.auth.providers.google === 'boolean', 'google flag missing');
});

await step('sign up with only email + password; name is derived', async () => {
  const r = await dana.req('POST', '/auth/signup', { email: danaEmail, password: pw });
  assert(r.status === 201, `signup ${r.status} ${JSON.stringify(r.data)}`);
  assert(r.data.user.name === `Dana ${run}`.replace(/ (\w)/, (_, c) => ` ${c.toUpperCase()}`) || r.data.user.name.startsWith('Dana'), `unexpected name ${r.data.user.name}`);
  assert(r.data.user.hasPassword === true && r.data.user.emailVerified === false, 'flags wrong');
  assert(dana.jar.has('nav_session'), 'no session cookie');
});

await step('wrong password is rejected; right one signs in', async () => {
  const b = new Browser();
  assert((await b.req('POST', '/auth/login', { email: danaEmail, password: 'nope-nope' })).status === 401, 'bad password should 401');
  assert((await b.req('POST', '/auth/login', { email: danaEmail, password: pw })).status === 200, 'good password should 200');
});

await step('forgot password answers the same for unknown emails', async () => {
  const r = await new Browser().req('POST', '/auth/password/forgot', { email: `ghost.${run}@nav.test` });
  assert(r.status === 202, `expected 202, got ${r.status}`);
});

await step('password reset: link works once, verifies email, signs out other sessions', async () => {
  const other = new Browser();
  await other.req('POST', '/auth/login', { email: danaEmail, password: pw });
  assert((await other.req('GET', '/auth/me')).status === 200, 'other session should work before reset');
  assert((await new Browser().req('POST', '/auth/password/forgot', { email: danaEmail })).status === 202, 'forgot failed');
  const token = await resetLinkFor(danaEmail);
  const peek = await new Browser().req('GET', `/auth/password/reset/${token}`);
  assert(peek.status === 200 && peek.data.email.endsWith('@nav.test') && !peek.data.email.startsWith(danaEmail.slice(0, 4)), `masked email wrong: ${JSON.stringify(peek.data)}`);
  const fresh = new Browser();
  const newPw = `${pw}-2`;
  const r = await fresh.req('POST', '/auth/password/reset', { token, password: newPw });
  assert(r.status === 200 && r.data.user.emailVerified === true, `reset ${r.status} ${JSON.stringify(r.data)}`);
  assert((await new Browser().req('POST', '/auth/password/reset', { token, password: 'another-one' })).status === 410, 'token reuse should 410');
  assert((await other.req('GET', '/auth/me')).status === 401, 'old session should be revoked');
  assert((await dana.req('GET', '/auth/me')).status === 401, 'original session should be revoked');
  Object.assign(dana, fresh);
  dana.jar = fresh.jar;
  (globalThis as any).danaPw = newPw;
});

await step('profile, email change needs the current password', async () => {
  assert((await dana.req('PATCH', '/auth/me', { name: 'Dana Q' })).data.user.name === 'Dana Q', 'rename failed');
  assert((await dana.req('PATCH', '/auth/me', { avatarUrl: 'https://evil.example/x.png' })).status === 400, 'arbitrary avatar URL should be refused');
  assert((await dana.req('POST', '/auth/me/email', { email: `dana2.${run}@nav.test`, currentPassword: 'wrong-pass' })).status === 403, 'wrong password should 403');
  const ok = await dana.req('POST', '/auth/me/email', { email: `dana2.${run}@nav.test`, currentPassword: (globalThis as any).danaPw });
  assert(ok.status === 200 && ok.data.user.emailVerified === false, 'email change should succeed and reset verification');
});

await step('sessions: list, revoke one, sign out others', async () => {
  const second = new Browser();
  await second.req('POST', '/auth/login', { email: `dana2.${run}@nav.test`, password: (globalThis as any).danaPw });
  const list = await dana.req('GET', '/auth/sessions');
  assert(list.data.items.length >= 2 && list.data.items.filter((s: any) => s.current).length === 1, 'session list wrong');
  const target = list.data.items.find((s: any) => !s.current);
  assert((await dana.req('DELETE', `/auth/sessions/${target.id}`)).status === 204, 'revoke failed');
  assert((await new Browser().req('DELETE', `/auth/sessions/${target.id}`)).status === 401, 'revoke without auth should 401');
  await second.req('POST', '/auth/login', { email: `dana2.${run}@nav.test`, password: (globalThis as any).danaPw });
  assert((await dana.req('DELETE', '/auth/sessions')).status === 204, 'sign out others failed');
  assert((await second.req('GET', '/auth/me')).status === 401, 'other session still alive');
  assert((await dana.req('GET', '/auth/me')).status === 200, 'current session should survive');
});

await step('CSRF: cookie-authenticated mutation without the header is refused', async () => {
  const r = await fetch(`${API}/auth/me`, { method: 'PATCH', headers: { cookie: dana.cookieHeader(), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
  assert(r.status === 403, `expected 403, got ${r.status}`);
});

const ssoEmail = `alice.${run}@sso.test`;
const alice = new Browser();
await step('SSO: unknown domain is refused', async () => {
  const r = await alice.req('POST', '/auth/sso', { email: `alice@elsewhere.test` });
  assert(r.status === 404 && r.data.error.code === 'sso_not_configured', `got ${r.status}`);
});

await step('SSO: full OIDC round trip creates a verified account and signs in', async () => {
  const before = idpTokenCalls;
  const { final } = await alice.sso(ssoEmail);
  assert(final.endsWith('/app'), `expected redirect to /app, got ${final}`);
  assert(idpTokenCalls === before + 1, 'token endpoint not called exactly once');
  const me = await alice.req('GET', '/auth/me');
  assert(me.status === 200 && me.data.user.email === ssoEmail && me.data.user.emailVerified && !me.data.user.hasPassword, `me wrong ${JSON.stringify(me.data)}`);
  assert(me.data.workspaces.length === 1, 'workspace not created');
  const ids = await alice.req('GET', '/auth/identities');
  assert(ids.data.items.some((i: any) => i.provider === 'sso'), 'identity not stored');
});

await step('SSO: signing in again reuses the same account', async () => {
  const b = new Browser();
  await b.sso(ssoEmail);
  const a = await alice.req('GET', '/auth/me');
  const c = await b.req('GET', '/auth/me');
  assert(a.data.user.id === c.data.user.id, 'second sign-in created a new account');
});

await step('OAuth: forged state is rejected without a session', async () => {
  const b = new Browser();
  const { final } = await b.sso(ssoEmail, { tamperState: true });
  assert(final.includes('error=bad_state'), `expected bad_state, got ${final}`);
  assert(!b.jar.has('nav_session'), 'session should not be issued');
});

await step('linking: unverified password account with same email is NOT taken over', async () => {
  const victimEmail = `bob.${run}@sso.test`;
  const squatter = new Browser();
  assert((await squatter.req('POST', '/auth/signup', { email: victimEmail, password: 'squatter-pass-1' })).status === 201, 'squatter signup failed');
  const b = new Browser();
  const { final } = await b.sso(victimEmail);
  assert(final.includes('error=email_in_use'), `expected email_in_use, got ${final}`);
  assert(!b.jar.has('nav_session'), 'must not sign in to the squatted account');
});

await step('linking: verified password account links to the provider identity', async () => {
  const email = `carol.${run}@sso.test`;
  const c = new Browser();
  await c.req('POST', '/auth/signup', { email, password: 'carol-pass-123' });
  const meBefore = await c.req('GET', '/auth/me');
  await new Browser().req('POST', '/auth/password/forgot', { email });
  const token = await resetLinkFor(email);
  await new Browser().req('POST', '/auth/password/reset', { token, password: 'carol-pass-456' });
  const b = new Browser();
  const { final } = await b.sso(email);
  assert(final.endsWith('/app'), `expected success, got ${final}`);
  const me = await b.req('GET', '/auth/me');
  assert(me.data.user.id === meBefore.data.user.id, 'should link to the existing verified account');
});

await step('connect mode needs a session; disconnecting the only sign-in method is refused', async () => {
  const anon = new Browser();
  const start = await anon.req('GET', `${API}/auth/oauth/sso/start?mode=connect&login_hint=${encodeURIComponent(ssoEmail)}`);
  // Without a session the flow falls back to a normal sign-in rather than linking to nobody.
  const state = JSON.parse(Buffer.from(decodeURIComponent(anon.jar.get('nav_oauth') ?? ''), 'base64url').toString('utf8'));
  assert(start.status === 302 && state.m === 'login', `connect without session should degrade to login, got ${state.m}`);
  const r = await alice.req('DELETE', '/auth/identities/sso');
  assert(r.status === 409 && r.data.error.code === 'last_sign_in_method', `expected 409, got ${r.status}`);
});

await step('open redirect: next must be an in-app path', async () => {
  const b = new Browser();
  await b.req('GET', `${API}/auth/oauth/sso/start?login_hint=${encodeURIComponent(ssoEmail)}&next=${encodeURIComponent('//evil.example/x')}`);
  const state = JSON.parse(Buffer.from(decodeURIComponent(b.jar.get('nav_oauth') ?? ''), 'base64url').toString('utf8'));
  assert(state.n === '/app', `unsafe next kept: ${state.n}`);
});

await step('delete account: needs typed email + password, removes the user', async () => {
  const email = `erin.${run}@nav.test`;
  const e = new Browser();
  await e.req('POST', '/auth/signup', { email, password: 'erin-pass-123' });
  assert((await e.req('DELETE', '/auth/me', { confirm: 'wrong@nav.test', password: 'erin-pass-123' })).status === 400, 'confirm mismatch should 400');
  assert((await e.req('DELETE', '/auth/me', { confirm: email, password: 'bad-password' })).status === 403, 'wrong password should 403');
  assert((await e.req('DELETE', '/auth/me', { confirm: email, password: 'erin-pass-123' })).status === 204, 'delete failed');
  assert((await new Browser().req('POST', '/auth/login', { email, password: 'erin-pass-123' })).status === 401, 'deleted user can still sign in');
});

// ---- Provider sign-in: only authenticated, provider-verified users get a session ----

await step('provider buttons: only configured providers can start a sign-in', async () => {
  const cfg = await new Browser().req('GET', '/config');
  assert(cfg.data.auth.providers.gitlab === true && cfg.data.auth.providers.bitbucket === false, `expected gitlab on, bitbucket off: ${JSON.stringify(cfg.data.auth.providers)}`);
  const b = new Browser();
  const r = await b.req('GET', '/auth/oauth/bitbucket/start');
  assert(r.status === 302 && r.location?.includes('error=provider_disabled'), `unconfigured provider must not start: ${r.location}`);
  assert(!b.jar.has('nav_session'), 'no session');
  assert((await b.req('GET', '/auth/oauth/myspace/start')).status === 404, 'unknown providers 404');
});

await step('GitLab: confirmed account signs in through the full OAuth + PKCE round trip', async () => {
  const b = new Browser();
  const email = `gl.${run}@gitlab.test`;
  const { final } = await b.gitlab(email);
  assert(final.endsWith('/app'), `expected /app, got ${final}`);
  const me = await b.req('GET', '/auth/me');
  assert(me.status === 200 && me.data.user.email === email && me.data.user.emailVerified, `me: ${JSON.stringify(me.data)}`);
});

await step('GitLab: an unconfirmed email is refused and no account is created', async () => {
  const b = new Browser();
  const email = `unconfirmed.${run}@gitlab.test`;
  const { final } = await b.gitlab(email);
  assert(final.includes('error=unverified_email'), `expected unverified_email, got ${final}`);
  assert(!b.jar.has('nav_session'), 'no session for an unconfirmed address');
  // No account exists for that address: signing up with it still works.
  const signup = await new Browser().req('POST', '/auth/signup', { email, password: 'some-password-1' });
  assert(signup.status === 201, `no account should have been created, signup gave ${signup.status}`);
});

await step('GitLab: a callback without the state cookie is refused', async () => {
  const b = new Browser();
  const { final } = await b.gitlab(`nocookie.${run}@gitlab.test`, { dropStateCookie: true });
  assert(final.includes('error=bad_state'), `expected bad_state, got ${final}`);
  assert(!b.jar.has('nav_session'), 'no session');
});

await step('GitLab: a replayed callback URL does not sign anyone in', async () => {
  const b = new Browser();
  const { final, replay, thief } = await b.gitlab(`replay.${run}@gitlab.test`, { replayCode: true });
  assert(final.endsWith('/app'), 'the real user got in');
  assert(replay.includes('error=bad_state') && !thief.jar.has('nav_session'), `replay must fail: ${replay}`);
});

await step('provider sign-in still requires the second factor when 2FA is on', async () => {
  const b = new Browser();
  const email = `gl2fa.${run}@gitlab.test`;
  await b.gitlab(email);
  const setup = await b.req('POST', '/auth/mfa/setup');
  const { codeAt } = await import('../apps/control/src/lib/totp.ts');
  const code = codeAt(setup.data.secret, Math.floor(Date.now() / 30000));
  assert((await b.req('POST', '/auth/mfa/enable', { code })).status === 200, 'enable 2FA');
  const c = new Browser();
  const { final } = await c.gitlab(email);
  assert(final.endsWith('/login/mfa'), `expected the code step, got ${final}`);
  assert((await c.req('GET', '/auth/me')).status === 401, 'no session until the code is entered');
});

idp.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
