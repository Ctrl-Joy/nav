// External sign-in providers: OAuth 2.0 authorization-code flow with PKCE, plus generic OpenID Connect for SSO.
// GitHub keeps its own flow in routes/auth.ts because it also stores a repo-scoped token.
import { createHash, randomBytes } from 'node:crypto';
import { config } from '@nav/shared/config';
import { githubOAuthEnabled } from './github.ts';
import { effectiveProvider } from './providerSettings.ts';

export type ProviderId = 'github' | 'gitlab' | 'bitbucket' | 'google' | 'sso';
export const PROVIDERS: ProviderId[] = ['github', 'gitlab', 'bitbucket', 'google', 'sso'];

export interface Profile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
}

interface Endpoints {
  authorize: string;
  token: string;
  scope: string;
  /** Bitbucket wants client credentials as HTTP Basic auth; the rest take them in the form body. */
  basicAuth?: boolean;
  profile: (accessToken: string) => Promise<Profile>;
}

const TIMEOUT_MS = 10_000;

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return (await res.json()) as T;
}

/** Environment variables or admin-saved credentials; routes call ensureProviderSettings() before relying on this. */
export function providerEnabled(p: ProviderId): boolean {
  switch (p) {
    case 'github': return githubOAuthEnabled();
    case 'gitlab':
    case 'bitbucket':
    case 'google':
      return effectiveProvider(p).enabled;
    case 'sso': return !!(config.sso.issuer && config.sso.clientId && config.sso.clientSecret && config.sso.domains.length);
  }
}

export function clientFor(p: Exclude<ProviderId, 'github'>): { id: string; secret: string } {
  if (p === 'sso') return { id: config.sso.clientId, secret: config.sso.clientSecret };
  const c = effectiveProvider(p);
  return { id: c.clientId, secret: c.clientSecret };
}

let oidcCache: { at: number; doc: { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string } } | null = null;

/** OpenID discovery for the SSO issuer, cached for an hour. Endpoints must be HTTPS (localhost allowed for testing). */
async function oidc() {
  if (oidcCache && Date.now() - oidcCache.at < 3600_000) return oidcCache.doc;
  const res = await fetch(`${config.sso.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SSO discovery failed (${res.status})`);
  const doc = (await res.json()) as { issuer?: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string };
  for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.userinfo_endpoint]) {
    const url = new URL(u);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('SSO endpoints must use HTTPS');
  }
  oidcCache = { at: Date.now(), doc };
  return doc;
}

async function endpoints(p: Exclude<ProviderId, 'github'>): Promise<Endpoints> {
  switch (p) {
    case 'gitlab': {
      const base = effectiveProvider('gitlab').baseUrl ?? config.oauth.gitlab.baseUrl;
      return {
        authorize: `${base}/oauth/authorize`,
        token: `${base}/oauth/token`,
        scope: 'read_user',
        profile: async (t) => {
          const u = await getJson<{ id: number; username: string; name: string; email?: string; public_email?: string; avatar_url?: string; confirmed_at?: string | null }>(`${base}/api/v4/user`, t);
          // GitLab's /user `email` is the primary address; it counts only with a confirmation time.
          return { subject: String(u.id), email: u.email ?? null, emailVerified: !!u.email && !!u.confirmed_at, name: u.name, username: u.username, avatarUrl: u.avatar_url ?? null };
        },
      };
    }
    case 'bitbucket':
      return {
        authorize: 'https://bitbucket.org/site/oauth2/authorize',
        token: 'https://bitbucket.org/site/oauth2/access_token',
        scope: 'account email',
        basicAuth: true,
        profile: async (t) => {
          const u = await getJson<{ uuid: string; display_name: string; username?: string; nickname?: string; links?: { avatar?: { href?: string } } }>('https://api.bitbucket.org/2.0/user', t);
          const emails = await getJson<{ values: { email: string; is_primary: boolean; is_confirmed: boolean }[] }>('https://api.bitbucket.org/2.0/user/emails', t).catch(() => ({ values: [] }));
          const primary = emails.values.find((e) => e.is_primary && e.is_confirmed);
          return { subject: u.uuid, email: primary?.email ?? null, emailVerified: !!primary, name: u.display_name, username: u.username ?? u.nickname ?? null, avatarUrl: u.links?.avatar?.href ?? null };
        },
      };
    case 'google':
      return {
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile',
        profile: async (t) => {
          const u = await getJson<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>('https://openidconnect.googleapis.com/v1/userinfo', t);
          return { subject: u.sub, email: u.email ?? null, emailVerified: u.email_verified === true, name: u.name ?? null, username: null, avatarUrl: u.picture ?? null };
        },
      };
    case 'sso': {
      const doc = await oidc();
      return {
        authorize: doc.authorization_endpoint,
        token: doc.token_endpoint,
        scope: 'openid email profile',
        profile: async (t) => {
          const u = await getJson<{ sub: string; email?: string; email_verified?: boolean; name?: string; preferred_username?: string; picture?: string }>(doc.userinfo_endpoint, t);
          // An IdP that omits email_verified is trusted for the domains it was configured for.
          const domainOk = !!u.email && config.sso.domains.includes(u.email.split('@')[1]?.toLowerCase() ?? '');
          return { subject: u.sub, email: u.email ?? null, emailVerified: domainOk && u.email_verified !== false, name: u.name ?? null, username: u.preferred_username ?? null, avatarUrl: u.picture ?? null };
        },
      };
    }
  }
}

export function callbackUrl(p: ProviderId): string {
  return p === 'github' ? `${config.apiPublicUrl}/api/v1/auth/github/callback` : `${config.apiPublicUrl}/api/v1/auth/oauth/${p}/callback`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function authorizeUrl(p: Exclude<ProviderId, 'github'>, state: string, challenge: string, loginHint?: string): Promise<string> {
  const ep = await endpoints(p);
  const url = new URL(ep.authorize);
  url.searchParams.set('client_id', clientFor(p).id);
  url.searchParams.set('redirect_uri', callbackUrl(p));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ep.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (p === 'google') url.searchParams.set('prompt', 'select_account');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

/** Exchanges the authorization code (with its PKCE verifier) and loads the user's profile. */
export async function exchange(p: Exclude<ProviderId, 'github'>, code: string, verifier: string): Promise<Profile> {
  const ep = await endpoints(p);
  const client = clientFor(p);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(p), code_verifier: verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (ep.basicAuth) headers.authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`;
  else { form.set('client_id', client.id); form.set('client_secret', client.secret); }
  const res = await fetch(ep.token, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `token exchange failed (${res.status})`);
  return ep.profile(body.access_token);
}
