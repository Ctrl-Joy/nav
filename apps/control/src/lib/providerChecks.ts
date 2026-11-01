// Sign-in provider credentials: the rules for combining environment and saved values, and the "Test" checks the
// admin page runs. No database access here, so the logic can be unit-tested on its own.

export type ConfigurableProvider = 'github' | 'gitlab' | 'bitbucket' | 'google';
export const CONFIGURABLE_PROVIDERS: ConfigurableProvider[] = ['github', 'gitlab', 'bitbucket', 'google'];

export const DEFAULT_GITLAB_URL = 'https://gitlab.com';

export interface Credentials {
  clientId: string;
  clientSecret: string;
  /** GitLab only. */
  baseUrl?: string | null;
}

export interface Effective {
  /** Where the credentials come from. Environment variables always win over a saved row. */
  source: 'environment' | 'database' | null;
  clientId: string;
  clientSecret: string;
  baseUrl: string | null;
  /** Both halves present: the provider can be used to sign in. */
  enabled: boolean;
}

/**
 * Environment first: as soon as either variable is set the provider is managed by the environment (read-only on the
 * admin page), even if incomplete, so a half-configured deployment is reported rather than silently overridden.
 */
export function resolveEffective(p: ConfigurableProvider, env: Credentials, saved: Credentials | null, envGitlabUrl = DEFAULT_GITLAB_URL): Effective {
  const gitlab = p === 'gitlab';
  if (env.clientId || env.clientSecret) {
    return { source: 'environment', clientId: env.clientId, clientSecret: env.clientSecret, baseUrl: gitlab ? envGitlabUrl : null, enabled: !!(env.clientId && env.clientSecret) };
  }
  if (saved && saved.clientId && saved.clientSecret) {
    return { source: 'database', clientId: saved.clientId, clientSecret: saved.clientSecret, baseUrl: gitlab ? saved.baseUrl || envGitlabUrl : null, enabled: true };
  }
  return { source: null, clientId: '', clientSecret: '', baseUrl: gitlab ? envGitlabUrl : null, enabled: false };
}

/** "…a1b2": enough of a client id to recognise it. Short ids are not revealed at all. */
export function clientIdHint(clientId: string): string | null {
  return clientId.length >= 8 ? `…${clientId.slice(-4)}` : clientId ? '…' : null;
}

/** A self-managed GitLab URL: HTTPS (plain HTTP only for localhost), no credentials, query or fragment. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('enter a full URL, like https://gitlab.example.com');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('the GitLab URL must use https://');
  if (url.username || url.password || url.search || url.hash) throw new Error('the GitLab URL cannot contain credentials, a query or a fragment');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export const PROVIDER_INFO: Record<ConfigurableProvider, { name: string; scopes: string[]; envVars: string[] }> = {
  github: { name: 'GitHub', scopes: ['read:user', 'user:email', 'repo'], envVars: ['NAV_GITHUB_CLIENT_ID', 'NAV_GITHUB_CLIENT_SECRET'] },
  gitlab: { name: 'GitLab', scopes: ['read_user'], envVars: ['NAV_GITLAB_CLIENT_ID', 'NAV_GITLAB_CLIENT_SECRET', 'NAV_GITLAB_URL'] },
  bitbucket: { name: 'Bitbucket', scopes: ['account', 'email'], envVars: ['NAV_BITBUCKET_CLIENT_ID', 'NAV_BITBUCKET_CLIENT_SECRET'] },
  google: { name: 'Google', scopes: ['openid', 'email', 'profile'], envVars: ['NAV_GOOGLE_CLIENT_ID', 'NAV_GOOGLE_CLIENT_SECRET'] },
};

// ---- Test ----

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export interface Check { label: string; status: CheckStatus; detail: string }
export interface TestResult {
  /** true: everything that can be checked without a user passed. false: something is wrong. null: inconclusive. */
  ok: boolean | null;
  summary: string;
  checks: Check[];
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 10_000;
/** An authorization code no provider will ever have issued: the token endpoint judges the client first. */
const BOGUS_CODE = 'nav-credentials-check';

interface TokenReply { status: number; error: string; description: string }

async function postToken(f: Fetch, url: string, form: Record<string, string>, basic?: { id: string; secret: string }): Promise<TokenReply> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'nav-paas' };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`;
  const res = await f(url, { method: 'POST', headers, body: new URLSearchParams(form), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some providers answer errors as a form-encoded body.
    body = Object.fromEntries(new URLSearchParams(text));
  }
  const err = body.error;
  // Bitbucket nests it: { error: { message } } in a few cases.
  const error = typeof err === 'string' ? err : '';
  const description = String(body.error_description ?? (typeof err === 'object' && err ? (err as { message?: string }).message ?? '' : ''));
  return { status: res.status, error, description };
}

/**
 * What a token endpoint's answer to a made-up code says about the client credentials. Every provider checks the
 * client before the code, so "bad code" means the id and secret were accepted.
 */
export function classifyTokenReply(p: ConfigurableProvider, r: TokenReply): Check {
  const label = 'Client ID and secret';
  const said = [r.error, r.description].filter(Boolean).join(': ') || `HTTP ${r.status}`;
  const badCode = p === 'github' ? ['bad_verification_code'] : ['invalid_grant'];
  const badClient = p === 'github' ? ['incorrect_client_credentials'] : ['invalid_client', 'unauthorized_client'];
  if (badCode.includes(r.error)) return { label, status: 'pass', detail: `${PROVIDER_INFO[p].name} accepted the client credentials (it only rejected the test code, as expected).` };
  if (badClient.includes(r.error)) return { label, status: 'fail', detail: `${PROVIDER_INFO[p].name} rejected the client ID or secret (${said}). Copy both again from the OAuth app.` };
  if (/redirect_uri/i.test(r.error) || /redirect/i.test(r.description)) {
    return { label, status: 'warn', detail: `The credentials look valid, but ${PROVIDER_INFO[p].name} says the callback URL doesn't match (${said}). Register the exact callback URL shown on this page.` };
  }
  if (r.status === 429) return { label, status: 'skip', detail: `${PROVIDER_INFO[p].name} is rate-limiting requests; try again in a minute.` };
  return { label, status: 'skip', detail: `Couldn't tell from ${PROVIDER_INFO[p].name}'s answer (${said}). Try signing in to confirm.` };
}

function summarize(p: ConfigurableProvider, checks: Check[]): TestResult {
  const name = PROVIDER_INFO[p].name;
  if (checks.some((c) => c.status === 'fail')) return { ok: false, summary: `${name} is not set up correctly.`, checks };
  if (checks.some((c) => c.status === 'skip' || c.status === 'warn')) return { ok: null, summary: `Some checks were inconclusive. Signing in with ${name} is the final test.`, checks };
  return { ok: true, summary: `${name} accepted these credentials. Sign in with ${name} once to finish checking the callback URL.`, checks };
}

async function guarded(label: string, fn: () => Promise<Check>): Promise<Check> {
  try {
    return await fn();
  } catch (err) {
    const e = err as Error;
    const why = e.name === 'TimeoutError' ? 'timed out' : e.message;
    return { label, status: 'fail', detail: `Couldn't reach the provider from this server (${why}).` };
  }
}

/**
 * Checks what can be checked without a person signing in. The final redirect back to NAV (the registered callback
 * URL, consent screen, verified email) can only be confirmed by actually signing in.
 */
export async function testProvider(p: ConfigurableProvider, creds: Credentials, callbackUrl: string, f: Fetch = fetch): Promise<TestResult> {
  const checks: Check[] = [];
  if (!creds.clientId || !creds.clientSecret) {
    return { ok: false, summary: 'Enter a client ID and secret first.', checks: [{ label: 'Client ID and secret', status: 'fail', detail: 'Both are required.' }] };
  }
  const form = { grant_type: 'authorization_code', code: BOGUS_CODE, redirect_uri: callbackUrl };
  switch (p) {
    case 'github': {
      if (!/^(Iv\d+\.)?[A-Za-z0-9_.-]{16,40}$/.test(creds.clientId)) {
        checks.push({ label: 'Client ID format', status: 'warn', detail: 'This does not look like a GitHub OAuth client ID (usually 20 characters, like Ov23li…).' });
      }
      checks.push(await guarded('Client ID and secret', async () => classifyTokenReply('github', await postToken(f, 'https://github.com/login/oauth/access_token', { client_id: creds.clientId, client_secret: creds.clientSecret, code: BOGUS_CODE, redirect_uri: callbackUrl }))));
      break;
    }
    case 'gitlab': {
      const base = creds.baseUrl || DEFAULT_GITLAB_URL;
      checks.push(await guarded('GitLab instance', async () => {
        const res = await f(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
        if (!res.ok) return { label: 'GitLab instance', status: 'fail', detail: `${base} did not answer like a GitLab instance (HTTP ${res.status}).` };
        const doc = (await res.json().catch(() => ({}))) as { token_endpoint?: string };
        return doc.token_endpoint ? { label: 'GitLab instance', status: 'pass', detail: `${base} is reachable.` } : { label: 'GitLab instance', status: 'warn', detail: `${base} answered, but not with GitLab's OpenID configuration.` };
      }));
      if (checks[checks.length - 1].status !== 'fail') {
        checks.push(await guarded('Client ID and secret', async () => classifyTokenReply('gitlab', await postToken(f, `${base}/oauth/token`, { ...form, client_id: creds.clientId, client_secret: creds.clientSecret }))));
      }
      break;
    }
    case 'bitbucket':
      checks.push(await guarded('Client ID and secret', async () => classifyTokenReply('bitbucket', await postToken(f, 'https://bitbucket.org/site/oauth2/access_token', form, { id: creds.clientId, secret: creds.clientSecret }))));
      break;
    case 'google': {
      checks.push(await guarded('Google discovery document', async () => {
        const res = await f('https://accounts.google.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(TIMEOUT_MS) });
        return res.ok ? { label: 'Google discovery document', status: 'pass', detail: 'accounts.google.com is reachable from this server.' } : { label: 'Google discovery document', status: 'fail', detail: `accounts.google.com returned HTTP ${res.status}.` };
      }));
      checks.push(
        /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(creds.clientId)
          ? { label: 'Client ID format', status: 'pass', detail: 'Looks like a Google OAuth client ID.' }
          : { label: 'Client ID format', status: 'fail', detail: 'Google client IDs look like 1234567890-abc123.apps.googleusercontent.com. Use the "Web application" client from Credentials.' },
      );
      checks.push(await guarded('Client ID and secret', async () => classifyTokenReply('google', await postToken(f, 'https://oauth2.googleapis.com/token', { ...form, client_id: creds.clientId, client_secret: creds.clientSecret }))));
      break;
    }
  }
  return summarize(p, checks);
}
