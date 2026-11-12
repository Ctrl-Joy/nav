// GitHub integration: App JWT auth, installation tokens, OAuth, repo listing, commit statuses, webhook signatures.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { config } from '@nav/shared/config';
import { effectiveProvider } from './providerSettings.ts';

const API = 'https://api.github.com';

export const githubAppEnabled = () => Boolean(config.github.appId && config.github.privateKey);
/** GitHub sign-in: environment variables or credentials saved on the admin page (call ensureProviderSettings() first). */
export const githubOAuthEnabled = () => effectiveProvider('github').enabled;
export const githubClientId = () => effectiveProvider('github').clientId;

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

export interface GhRepo { full_name: string; clone_url: string; default_branch: string; private: boolean; permissions?: { admin?: boolean } }

/** An installation of this GitHub App: which account it is on. Read with the App's own JWT. */
export async function appInstallation(installationId: number): Promise<{ id: number; account: { id: number; login: string; type: string } }> {
  return gh(`/app/installations/${installationId}`, { jwt: true });
}

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
  const client = effectiveProvider('github');
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri }),
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

/**
 * Creates or updates the single comment identified by `marker` (an HTML comment hidden in its body) on a PR.
 * Only comments written by a bot (our App) are considered, so a user quoting the marker cannot hijack it.
 */
export async function upsertPrComment(installationId: number | null, repoUrl: string, pr: number, marker: string, body: string): Promise<void> {
  if (!installationId || !githubAppEnabled()) return;
  const r = parseGithubRepo(repoUrl);
  if (!r) return;
  const token = await installationToken(installationId);
  const full = `${marker}\n${body}`;
  for (let page = 1; page <= 10; page++) {
    const comments = await gh<{ id: number; body?: string; user?: { type?: string } }[]>(`/repos/${r.owner}/${r.repo}/issues/${pr}/comments?per_page=100&page=${page}`, { token });
    const mine = comments.find((c) => c.user?.type === 'Bot' && c.body?.includes(marker));
    if (mine) {
      if (mine.body !== full) await gh(`/repos/${r.owner}/${r.repo}/issues/comments/${mine.id}`, { method: 'PATCH', token, body: JSON.stringify({ body: full }) });
      return;
    }
    if (comments.length < 100) break;
  }
  await gh(`/repos/${r.owner}/${r.repo}/issues/${pr}/comments`, { method: 'POST', token, body: JSON.stringify({ body: full }) });
}

export interface PreviewCommentRow { name: string; status: string; url: string | null; dashboardUrl: string }

const STATUS_LABEL: Record<string, string> = { live: '✅ Live', failed: '❌ Failed', canceled: '⏹️ Canceled', deploying: '⏳ Deploying', created: '⏳ Deploying', deleting: '🗑️ Deleted' };

/** Markdown for a preview comment: one row per service of the preview (one for a single-service preview). */
export function previewCommentBody(title: string, rows: PreviewCommentRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `### 🧭 NAV preview: ${cell(title)}`,
    '',
    '| Service | Status | Preview URL | |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.name)} | ${STATUS_LABEL[r.status] ?? cell(r.status)} | ${r.url ? `[${r.url.replace(/^https?:\/\//, '')}](${r.url})` : '—'} | [Dashboard](${r.dashboardUrl}) |`),
    '',
    `<sub>Updated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC. This comment is updated as the preview deploys.</sub>`,
  ];
  return lines.join('\n');
}

export interface CommitStatus { context: string; state: string }
export interface CheckRun { name: string; status: string; conclusion: string | null }

/** Check conclusions that count as passing: success, neutral or skipped. */
const PASSING = new Set(['success', 'neutral', 'skipped']);

/**
 * Folds a commit's legacy statuses and check runs into one verdict. Our own "NAV" status is ignored (it reflects
 * other services' deploys of the same commit, not CI). Anything still running makes the verdict pending.
 */
export function evaluateChecks(statuses: CommitStatus[], runs: CheckRun[]): 'success' | 'pending' | 'failure' {
  const ci = statuses.filter((s) => s.context !== 'NAV');
  if (ci.some((s) => s.state === 'failure' || s.state === 'error') || runs.some((r) => r.status === 'completed' && !PASSING.has(r.conclusion ?? ''))) return 'failure';
  if (ci.some((s) => s.state === 'pending') || runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'success';
}

/** Current statuses and check runs of a commit, read with the installation token. */
export async function commitChecks(installationId: number, repoUrl: string, sha: string): Promise<{ statuses: CommitStatus[]; runs: CheckRun[] }> {
  const r = parseGithubRepo(repoUrl);
  if (!r) throw new Error(`not a GitHub repository: ${repoUrl}`);
  const token = await installationToken(installationId);
  const combined = await gh<{ statuses: CommitStatus[] }>(`/repos/${r.owner}/${r.repo}/commits/${sha}/status?per_page=100`, { token });
  const runs: CheckRun[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await gh<{ check_runs: CheckRun[] }>(`/repos/${r.owner}/${r.repo}/commits/${sha}/check-runs?per_page=100&page=${page}`, { token });
    runs.push(...res.check_runs);
    if (res.check_runs.length < 100) break;
  }
  return { statuses: combined.statuses ?? [], runs };
}

export function verifyWebhookSignature(raw: Buffer, signature: string | undefined): boolean {
  if (!config.github.webhookSecret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', config.github.webhookSecret).update(raw).digest('hex'));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
