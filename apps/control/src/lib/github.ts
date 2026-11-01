// GitHub integration: App JWT auth, installation tokens, OAuth, repo listing, commit statuses, webhook signatures.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { config } from '@nav/shared/config';

const API = 'https://api.github.com';

export const githubAppEnabled = () => Boolean(config.github.appId && config.github.privateKey);
export const githubOAuthEnabled = () => Boolean(config.github.clientId && config.github.clientSecret);

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: config.github.appId })}`;
  const sig = createSign('RSA-SHA256').update(body).sign(config.github.privateKey).toString('base64url');
  return `${body}.${sig}`;
}

async function gh<T>(path: string, init: RequestInit & { token?: string; jwt?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'nav-paas',
  };
  if (init.jwt) headers.authorization = `Bearer ${appJwt()}`;
  else if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(path.startsWith('http') ? path : API + path, { ...init, headers: { ...headers, ...(init.headers as object) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const tokenCache = new Map<number, { token: string; expires: number }>();

export async function installationToken(installationId: number): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.expires - Date.now() > 120_000) return hit.token;
  const res = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, { method: 'POST', jwt: true });
  tokenCache.set(installationId, { token: res.token, expires: Date.parse(res.expires_at) });
  return res.token;
}

export interface GhRepo { full_name: string; clone_url: string; default_branch: string; private: boolean }

export async function installationRepos(installationId: number): Promise<GhRepo[]> {
  const token = await installationToken(installationId);
  const out: GhRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh<{ repositories: GhRepo[] }>(`/installation/repositories?per_page=100&page=${page}`, { token });
    out.push(...res.repositories);
    if (res.repositories.length < 100) break;
  }
  return out;
}

export async function userRepos(userToken: string): Promise<GhRepo[]> {
  return gh<GhRepo[]>('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', { token: userToken });
}

/**
 * Exchanges a GitHub authorization code (with its PKCE verifier) for a token and the user. `email` is only ever
 * the account's primary address when GitHub marks it verified; otherwise it is null and sign-in is refused.
 */
export async function oauthExchange(code: string, verifier: string, redirectUri: string): Promise<{ token: string; user: { id: number; login: string; name: string | null; email: string | null; avatar_url: string } }> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(body.error_description ?? 'GitHub OAuth failed');
  const user = await gh<{ id: number; login: string; name: string | null; email: string | null; avatar_url: string }>('/user', { token: body.access_token });
  const emails = await gh<{ email: string; primary: boolean; verified: boolean }[]>('/user/emails', { token: body.access_token }).catch(() => []);
  user.email = emails.find((e) => e.primary && e.verified)?.email ?? null;
  return { token: body.access_token, user };
}

/** Parses owner/repo from https://github.com/owner/repo(.git) */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function setCommitStatus(installationId: number | null, repoUrl: string, sha: string, state: 'pending' | 'success' | 'failure' | 'error', description: string, targetUrl: string): Promise<void> {
  if (!installationId || !githubAppEnabled()) return;
  const r = parseGithubRepo(repoUrl);
  if (!r) return;
  const token = await installationToken(installationId);
  await gh(`/repos/${r.owner}/${r.repo}/statuses/${sha}`, {
    method: 'POST',
    token,
    body: JSON.stringify({ state, description: description.slice(0, 140), context: 'NAV', target_url: targetUrl }),
  });
}

export async function commentOnPr(installationId: number | null, repoUrl: string, pr: number, body: string): Promise<void> {
  if (!installationId || !githubAppEnabled()) return;
  const r = parseGithubRepo(repoUrl);
  if (!r) return;
  const token = await installationToken(installationId);
  await gh(`/repos/${r.owner}/${r.repo}/issues/${pr}/comments`, { method: 'POST', token, body: JSON.stringify({ body }) });
}

export function verifyWebhookSignature(raw: Buffer, signature: string | undefined): boolean {
  if (!config.github.webhookSecret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', config.github.webhookSecret).update(raw).digest('hex'));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
