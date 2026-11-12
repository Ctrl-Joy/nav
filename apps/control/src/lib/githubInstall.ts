// Linking a GitHub App installation to the NAV workspace of the user who started the install.
//
// The install button sends the browser through /workspaces/:ws/github/install, which hands GitHub a signed `state`. GitHub returns it,
// with the installation id, to the Setup URL. The signed state is what ties the installation to that exact user and workspace, so the
// link no longer depends on guessing which NAV user a GitHub account belongs to.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InstallState {
  /** NAV user who started the install. */
  u: string;
  /** Workspace the installation is for. */
  w: string;
  /** Dashboard path to return to afterwards. */
  n: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}

const PURPOSE = 'github-app-install:v1:';
const TTL_SECONDS = 15 * 60;

function key(masterKeyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error('NAV_MASTER_KEY must be 64 hex characters');
  return Buffer.from(masterKeyHex, 'hex');
}

const mac = (payload: string, masterKeyHex: string) => createHmac('sha256', key(masterKeyHex)).update(PURPOSE + payload).digest('base64url');

export function signInstallState(user: string, workspace: string, next: string, masterKeyHex: string, now = Date.now()): string {
  const state: InstallState = { u: user, w: workspace, n: safeNext(next, workspace), e: Math.floor(now / 1000) + TTL_SECONDS };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${mac(payload, masterKeyHex)}`;
}

/** The state if it is genuine and unexpired, otherwise null. */
export function verifyInstallState(token: string | undefined, masterKeyHex: string, now = Date.now()): InstallState | null {
  if (!token || token.length > 2048) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(payload, masterKeyHex));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as InstallState;
    if (typeof s.u !== 'string' || typeof s.w !== 'string' || typeof s.n !== 'string' || typeof s.e !== 'number') return null;
    return s.e * 1000 > now ? s : null;
  } catch {
    return null;
  }
}

/** Only dashboard paths inside the workspace are allowed as a return target, never another site. */
export function safeNext(next: string | undefined, workspace: string): string {
  const fallback = `/w/${workspace}`;
  if (!next || next.length > 300 || !next.startsWith(`/w/${workspace}`) || next.startsWith('//') || /[\\\r\n]/.test(next)) return fallback;
  return next;
}

/** Appends one query parameter to a dashboard path. */
export function withParam(path: string, name: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;
}

export interface InstallationInfo { id: number; account: { id: number; login: string; type: string } }
export interface RepoAccess { fullName: string; admin: boolean }

/**
 * Whether the signed-in NAV user may claim this installation. They must have connected GitHub (we hold their token) and either
 * own the account the app was installed on, or administer at least one repository the installation can see (organisation installs).
 */
export function mayClaimInstallation(
  inst: InstallationInfo,
  githubUserId: number | null,
  installationRepoNames: string[],
  userRepos: RepoAccess[],
): { ok: true } | { ok: false; reason: string } {
  if (githubUserId == null) return { ok: false, reason: 'Connect GitHub to NAV first, then install the app again.' };
  if (inst.account.type === 'User') {
    return inst.account.id === githubUserId
      ? { ok: true }
      : { ok: false, reason: `The app was installed on ${inst.account.login}, which is not the GitHub account connected to your NAV user.` };
  }
  const visible = new Set(installationRepoNames.map((n) => n.toLowerCase()));
  const administers = userRepos.some((r) => r.admin && visible.has(r.fullName.toLowerCase()));
  return administers
    ? { ok: true }
    : { ok: false, reason: `You need admin access to a repository in ${inst.account.login} to link its installation.` };
}
