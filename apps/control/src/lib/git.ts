// Thin wrappers around the git CLI. Repo URLs are validated to prevent option/protocol injection.
import { spawn } from 'node:child_process';
import { one } from '../db/pool.ts';
import { badRequest } from './core.ts';
import { githubAppEnabled, installationToken, parseGithubRepo } from './github.ts';

export function validateRepoUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('repository URL must be an https:// URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
    throw badRequest('repository URL must use https');
  }
  if (u.username || u.password) throw badRequest('do not embed credentials in the repository URL');
  return u.toString().replace(/\/$/, '');
}

export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function git(args: string[], opts: { cwd?: string; timeoutMs?: number; onLine?: (l: string) => void } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'protocol.file.allow=never', '-c', 'credential.helper=', ...args], {
      cwd: opts.cwd,
      env: gitEnv(),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (opts.onLine) for (const l of d.toString().split(/\r?\n|\r/)) if (l.trim()) opts.onLine(l.trim());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Returns a URL git can fetch, injecting a GitHub App installation token for private repos. */
export async function authedUrl(repoUrl: string, installationId: number | null): Promise<string> {
  if (installationId && githubAppEnabled() && parseGithubRepo(repoUrl)) {
    const token = await installationToken(installationId);
    const u = new URL(repoUrl);
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  }
  return repoUrl;
}

/** Finds an installation that can access the repo (for webhooks/private repos). */
export async function installationFor(workspaceId: string, repoUrl: string): Promise<number | null> {
  const r = parseGithubRepo(repoUrl);
  if (!r) return null;
  const row = await one('SELECT id FROM github_installations WHERE workspace_id = $1 AND lower(account_login) = lower($2)', [workspaceId, r.owner]);
  return row ? Number(row.id) : null;
}

export async function lsRemote(repoUrl: string, installationId: number | null = null): Promise<{ branches: string[]; heads: Map<string, string>; defaultBranch: string | null }> {
  const url = await authedUrl(repoUrl, installationId);
  const res2 = await git(['ls-remote', '--symref', url], { timeoutMs: 30_000 });
  if (res2.code !== 0) throw badRequest(`could not access repository: ${res2.stderr.split('\n')[0].replace(/x-access-token:[^@]+@/, '')}`);
  const heads = new Map<string, string>();
  let defaultBranch: string | null = null;
  for (const line of res2.stdout.split('\n')) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD/);
    if (sym) defaultBranch = sym[1];
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/);
    if (m) heads.set(m[2], m[1]);
  }
  return { branches: [...heads.keys()].sort(), heads, defaultBranch };
}
