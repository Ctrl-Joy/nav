// Organizations: verified email domains, single-sign-on policy, and provisioning users into an org (shared by SAML
// just-in-time sign-in and SCIM).
import { resolveTxt } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { config } from '@nav/shared/config';
import { id } from '@nav/shared/ids';
import { one, q, tx, type Client } from '../db/pool.ts';
import { HttpError, conflict } from './core.ts';
import { isLocalDomain } from './domains.ts';

export type OrgRole = 'owner' | 'admin' | 'member';
export const ORG_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

export const DOMAIN_RE = /^(?=.{4,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
export const TXT_PREFIX = '_nav-verify';
export const newVerifyToken = () => randomBytes(18).toString('base64url');

/** The org that verified this email's domain, with its SAML policy, if any. */
export async function orgForEmail(email: string): Promise<{ orgId: string; samlEnabled: boolean; enforce: boolean } | null> {
  const row = await one(
    `SELECT d.org_id, COALESCE(s.enabled, false) AS enabled, COALESCE(s.enforce, false) AS enforce
     FROM org_domains d LEFT JOIN saml_configs s ON s.org_id = d.org_id
     WHERE d.domain = $1 AND d.verified_at IS NOT NULL`,
    [emailDomain(email)],
  );
  return row ? { orgId: row.org_id, samlEnabled: row.enabled, enforce: row.enabled && row.enforce } : null;
}

/** Refuses password and OAuth sign-in for accounts whose domain belongs to an org that enforces SAML. */
export async function assertSsoNotRequired(email: string): Promise<void> {
  const org = await orgForEmail(email);
  if (org?.enforce) throw new HttpError(403, 'sso_required', 'your organization requires single sign-on — use "Sign in with SSO"');
}

/** Checks the TXT record for a domain; on success marks it verified (unless another org verified it first). */
export async function verifyOrgDomain(domainId: string): Promise<{ verified: boolean; error: string | null }> {
  const d = await one('SELECT * FROM org_domains WHERE id = $1', [domainId]);
  if (!d) return { verified: false, error: 'not found' };
  const expected = `nav-verify=${d.verify_token}`;
  let ok = false;
  let reason = '';
  if (isLocalDomain(d.domain) && config.env !== 'production') ok = true;
  else {
    const records = await resolveTxt(`${TXT_PREFIX}.${d.domain}`).catch(() => [] as string[][]);
    const values = records.map((chunks) => chunks.join(''));
    ok = values.some((v) => v.trim() === expected);
    if (!ok) reason = values.length ? `found ${values.length} TXT record(s) on ${TXT_PREFIX}.${d.domain}, none is ${expected}` : `no TXT record found on ${TXT_PREFIX}.${d.domain} yet`;
  }
  if (ok) {
    const taken = await one('SELECT 1 FROM org_domains WHERE domain = $1 AND verified_at IS NOT NULL AND id <> $2', [d.domain, d.id]);
    if (taken) {
      reason = 'this domain is already verified by another organization';
      ok = false;
    }
  }
  if (ok) await q('UPDATE org_domains SET verified_at = COALESCE(verified_at, now()), last_checked_at = now(), last_error = NULL WHERE id = $1', [d.id]);
  else await q('UPDATE org_domains SET last_checked_at = now(), last_error = $2 WHERE id = $1', [d.id, reason]);
  return { verified: ok, error: ok ? null : reason };
}

export async function orgHasVerifiedDomain(orgId: string, email: string): Promise<boolean> {
  return !!(await one('SELECT 1 FROM org_domains WHERE org_id = $1 AND domain = $2 AND verified_at IS NOT NULL', [orgId, emailDomain(email)]));
}

/**
 * Finds or creates the NAV account for an address in a domain the org has proven it owns. The org's IdP is
 * authoritative for that address, so an existing account that never verified it is taken over: everything that
 * could belong to whoever registered it first (password, sessions, API keys, 2FA, linked identities) is revoked
 * before it is linked. That defeats pre-registering a colleague's address and waiting for SSO to link it.
 */
export async function claimAccount(c: Client, email: string, name: string): Promise<{ userId: string; created: boolean; tookOver: boolean }> {
  const existing = (await c.query('SELECT id, email_verified_at FROM users WHERE email = $1 FOR UPDATE', [email])).rows[0];
  if (existing) {
    if (existing.email_verified_at) return { userId: existing.id, created: false, tookOver: false };
    await c.query(
      `UPDATE users SET password_hash = NULL, email_verified_at = now(), totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL,
         totp_last_counter = NULL, recovery_codes = '[]', github_id = NULL, github_login = NULL, github_token_enc = NULL WHERE id = $1`,
      [existing.id],
    );
    await revokeAccess(c, existing.id);
    await c.query('DELETE FROM user_identities WHERE user_id = $1', [existing.id]);
    return { userId: existing.id, created: false, tookOver: true };
  }
  const userId = id('usr');
  await c.query('INSERT INTO users (id, email, name, email_verified_at) VALUES ($1,$2,$3, now())', [userId, email, name.slice(0, 100) || email.split('@')[0]]);
  const invites = await c.query('UPDATE workspace_invites SET accepted_at = now() WHERE lower(email) = lower($1) AND accepted_at IS NULL RETURNING workspace_id, role', [email]);
  for (const inv of invites.rows) {
    await c.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [inv.workspace_id, userId, inv.role]);
  }
  return { userId, created: true, tookOver: false };
}

/** Signs the user out everywhere and revokes their API keys. */
export async function revokeAccess(c: Client | null, userId: string): Promise<void> {
  const run = (sql: string) => (c ? c.query(sql, [userId]) : q(sql, [userId]));
  await run('DELETE FROM sessions WHERE user_id = $1');
  await run('DELETE FROM api_keys WHERE user_id = $1');
  await run('DELETE FROM mfa_challenges WHERE user_id = $1');
}

/** Makes the user an org member and puts them in the org's default workspace with the default role. */
export async function provisionOrgUser(c: Client, orgId: string, userId: string): Promise<void> {
  await c.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [orgId, userId]);
  const org = (await c.query('SELECT default_workspace_id, default_role FROM orgs WHERE id = $1', [orgId])).rows[0];
  if (org?.default_workspace_id) {
    await c.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [org.default_workspace_id, userId, org.default_role]);
  }
  await syncGroupRoles(c, orgId, userId);
}

/**
 * Removes the user from the org and every workspace it owns, and revokes their sessions and API keys.
 * The last org owner cannot be deprovisioned (that would orphan the org).
 */
export async function deprovisionOrgUser(c: Client, orgId: string, userId: string): Promise<void> {
  const m = (await c.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows[0];
  if (m?.role === 'owner') {
    const owners = (await c.query("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId])).rows[0].n;
    if (owners <= 1) throw conflict('the last owner of an organization cannot be deprovisioned');
  }
  await c.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  await c.query('DELETE FROM workspace_members WHERE user_id = $2 AND workspace_id IN (SELECT id FROM workspaces WHERE org_id = $1)', [orgId, userId]);
  await revokeAccess(c, userId);
}

/**
 * Applies SCIM group mappings for one user: membership in a mapped group grants its role in its workspace
 * (the highest role wins when several groups map to one workspace). Memberships that only came from a mapping
 * are removed when the user leaves the group.
 */
export async function syncGroupRoles(c: Client, orgId: string, userId: string): Promise<void> {
  const rank: Record<string, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };
  const mapped = (await c.query('SELECT DISTINCT workspace_id FROM scim_groups WHERE org_id = $1 AND workspace_id IS NOT NULL', [orgId])).rows.map((r) => r.workspace_id as string);
  const active = (await c.query('SELECT 1 FROM scim_users WHERE org_id = $1 AND user_id = $2 AND active', [orgId, userId])).rowCount;
  const desired = new Map<string, string>();
  if (active) {
    const rows = (await c.query(
      `SELECT g.workspace_id, g.role FROM scim_groups g JOIN scim_group_members gm ON gm.group_id = g.id JOIN scim_users su ON su.id = gm.scim_user_id
       WHERE g.org_id = $1 AND su.user_id = $2 AND g.workspace_id IS NOT NULL AND g.role IS NOT NULL`,
      [orgId, userId],
    )).rows;
    for (const r of rows) if ((rank[r.role] ?? -1) > (rank[desired.get(r.workspace_id) ?? ''] ?? -1)) desired.set(r.workspace_id, r.role);
  }
  for (const ws of mapped) {
    const want = desired.get(ws);
    const cur = (await c.query('SELECT role, scim_managed FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, userId])).rows[0];
    if (want) {
      // Never downgrade a role granted by hand; only manage memberships the mapping created.
      if (!cur) await c.query('INSERT INTO workspace_members (workspace_id, user_id, role, scim_managed) VALUES ($1,$2,$3,true)', [ws, userId, want]);
      else if (cur.scim_managed && cur.role !== want) await c.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [ws, userId, want]);
    } else if (cur?.scim_managed) {
      await c.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, userId]);
    }
  }
}

/** Re-applies group mappings for every member of a group (after the mapping itself changed). */
export async function syncGroup(groupId: string): Promise<void> {
  await tx(async (c) => {
    const g = (await c.query('SELECT org_id FROM scim_groups WHERE id = $1', [groupId])).rows[0];
    if (!g) return;
    const users = (await c.query('SELECT su.user_id FROM scim_group_members gm JOIN scim_users su ON su.id = gm.scim_user_id WHERE gm.group_id = $1', [groupId])).rows;
    for (const u of users) await syncGroupRoles(c, g.org_id, u.user_id);
  });
}

/** Re-applies mappings for all users of an org (a mapping was removed or moved). */
export async function syncOrgGroups(orgId: string, workspaceIds: string[] = []): Promise<void> {
  await tx(async (c) => {
    const users = (await c.query(
      `SELECT user_id FROM scim_users WHERE org_id = $1
       UNION SELECT user_id FROM workspace_members WHERE scim_managed AND workspace_id = ANY($2::text[])`,
      [orgId, workspaceIds],
    )).rows;
    for (const u of users) await syncGroupRoles(c, orgId, u.user_id);
    // A workspace no longer mapped by any group: drop the memberships mappings created there.
    for (const ws of workspaceIds) {
      const still = (await c.query('SELECT 1 FROM scim_groups WHERE org_id = $1 AND workspace_id = $2', [orgId, ws])).rowCount;
      if (!still) await c.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND scim_managed', [ws]);
    }
  });
}
