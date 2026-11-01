// Organizations: members, the workspaces an org owns, verified domains, SAML single sign-on and SCIM provisioning
// settings. Org owners/admins manage all of it; changes are recorded by the audit hook (routes carry :org).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '@nav/shared/config';
import { encrypt, sha256 } from '@nav/shared/crypto';
import { id, randomString } from '@nav/shared/ids';
import { one, q, tx } from '../../db/pool.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../../lib/core.ts';
import { DOMAIN_RE, TXT_PREFIX, emailDomain, newVerifyToken, syncGroup, syncOrgGroups, verifyOrgDomain, type OrgRole } from '../../lib/orgs.ts';
import { layout, sendMail } from '../../lib/mail.ts';
import { SamlError, acsUrl, certInfo, generateSpKeyPair, idpFromFields, loginUrl, parseIdpMetadata, spEntityId, type IdpSettings } from '../../lib/saml.ts';
import { orgRole, requireUser, workspaceRole } from '../auth.ts';
import { uniqueSlug, userOrgs } from './auth.ts';

const Name = z.string().trim().min(1).max(100);
const OrgRoleSchema = z.enum(['owner', 'admin', 'member']);
const WsRole = z.enum(['admin', 'developer', 'viewer']);

export const scimBaseUrl = () => `${config.apiPublicUrl}/scim/v2`;

function orgOut(r: Record<string, any>, role: OrgRole) {
  return {
    id: r.id, name: r.name, slug: r.slug, role, requireTwoFactor: r.require_2fa, defaultWorkspaceId: r.default_workspace_id ?? null,
    defaultRole: r.default_role, createdAt: r.created_at,
  };
}

function domainOut(r: Record<string, any>) {
  return {
    id: r.id, domain: r.domain, verified: !!r.verified_at, verifiedAt: r.verified_at ?? null, lastCheckedAt: r.last_checked_at ?? null, lastError: r.last_error ?? null,
    txtName: `${TXT_PREFIX}.${r.domain}`, txtValue: `nav-verify=${r.verify_token}`, createdAt: r.created_at,
  };
}

/** SAML settings row with the SP signing key pair; created on first use so admins can copy SP details into their IdP. */
export async function ensureSamlConfig(orgId: string) {
  const existing = await one('SELECT * FROM saml_configs WHERE org_id = $1', [orgId]);
  if (existing) return existing;
  const { cert, key } = await generateSpKeyPair(`NAV SAML ${orgId}`);
  await q('INSERT INTO saml_configs (org_id, sp_cert, sp_key_enc) VALUES ($1,$2,$3) ON CONFLICT (org_id) DO NOTHING', [orgId, cert, encrypt(key)]);
  return (await one('SELECT * FROM saml_configs WHERE org_id = $1', [orgId]))!;
}

function samlOut(orgId: string, r: Record<string, any>) {
  const certs = (r.idp_certs as string[]) ?? [];
  return {
    enabled: r.enabled,
    enforce: r.enforce,
    configured: !!(r.idp_entity_id && r.idp_sso_url && certs.length),
    sp: { entityId: spEntityId(orgId), acsUrl: acsUrl(orgId), metadataUrl: spEntityId(orgId), loginUrl: loginUrl(orgId), certificate: r.sp_cert },
    idp: {
      entityId: r.idp_entity_id ?? null, ssoUrl: r.idp_sso_url ?? null, binding: r.request_binding,
      certificates: certs.map((c) => { try { return certInfo(c); } catch { return { subject: 'unreadable', notAfter: null, fingerprint256: null }; } }),
    },
    updatedAt: r.updated_at,
  };
}

const MAX_PENDING_ORG_INVITES = 500;

function orgInviteOut(r: Record<string, any>) {
  return { id: r.id, email: r.email, role: r.role as OrgRole, createdAt: r.created_at, expiresAt: r.expires_at };
}

async function assertNotLastOrgOwner(orgId: string, userId: string, newRole: OrgRole | null) {
  if (newRole === 'owner') return;
  const target = await one('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (target?.role !== 'owner') return;
  const owners = await one<{ n: number }>("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
  if ((owners?.n ?? 0) <= 1) throw conflict('an organization must keep at least one owner');
}

async function orgWorkspace(orgId: string, workspaceId: string) {
  const ws = await one('SELECT * FROM workspaces WHERE id = $1 AND org_id = $2', [workspaceId, orgId]);
  if (!ws) throw notFound('workspace');
  return ws;
}

export async function orgRoutes(app: FastifyInstance) {
  app.get('/orgs', async (req) => ({ items: await userOrgs(requireUser(req).id), nextCursor: null }));

  /** Creates an org owned by the caller, with a new workspace — or around an existing workspace the caller owns. */
  app.post('/orgs', async (req, reply) => {
    const u = requireUser(req);
    const body = z.object({ name: Name, workspaceId: z.string().max(64).optional() }).parse(req.body);
    if (body.workspaceId) {
      if ((await workspaceRole(req, body.workspaceId, 'owner')) !== 'owner') throw forbidden();
      const ws = await one('SELECT org_id FROM workspaces WHERE id = $1', [body.workspaceId]);
      if (ws?.org_id) throw conflict('that workspace already belongs to an organization');
    }
    const orgId = id('org');
    await tx(async (c) => {
      await c.query('INSERT INTO orgs (id, name, slug) VALUES ($1,$2,$3)', [orgId, body.name, await uniqueSlug(c, 'orgs', body.name)]);
      await c.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,'owner')", [orgId, u.id]);
      let wsId = body.workspaceId;
      if (!wsId) {
        wsId = id('ws');
        await c.query('INSERT INTO workspaces (id, name, slug, org_id) VALUES ($1,$2,$3,$4)', [wsId, body.name, await uniqueSlug(c, 'workspaces', body.name), orgId]);
        await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [wsId, u.id]);
      } else await c.query('UPDATE workspaces SET org_id = $2 WHERE id = $1', [wsId, orgId]);
      await c.query('UPDATE orgs SET default_workspace_id = $2 WHERE id = $1', [orgId, wsId]);
    });
    req.auditOrgId = orgId;
    return reply.status(201).send(orgOut((await one('SELECT * FROM orgs WHERE id = $1', [orgId]))!, 'owner'));
  });

  app.get('/orgs/:org', async (req) => {
    const { org } = req.params as { org: string };
    const role = await orgRole(req, org);
    return orgOut((await one('SELECT * FROM orgs WHERE id = $1', [org]))!, role);
  });

  app.patch('/orgs/:org', async (req) => {
    const { org } = req.params as { org: string };
    const role = await orgRole(req, org, 'admin');
    const body = z.object({ name: Name.optional(), requireTwoFactor: z.boolean().optional(), defaultWorkspaceId: z.string().max(64).nullable().optional(), defaultRole: WsRole.optional() }).parse(req.body);
    if (body.requireTwoFactor) {
      const me = await one('SELECT totp_enabled_at FROM users WHERE id = $1', [requireUser(req).id]);
      if (!me?.totp_enabled_at) throw new HttpError(400, 'mfa_required', 'turn on two-factor authentication for your own account first');
    }
    if (body.defaultWorkspaceId) await orgWorkspace(org, body.defaultWorkspaceId);
    await q(
      `UPDATE orgs SET name = COALESCE($2, name), require_2fa = COALESCE($3, require_2fa), default_role = COALESCE($4, default_role),
         default_workspace_id = CASE WHEN $5 THEN $6 ELSE default_workspace_id END WHERE id = $1`,
      [org, body.name ?? null, body.requireTwoFactor ?? null, body.defaultRole ?? null, body.defaultWorkspaceId !== undefined, body.defaultWorkspaceId ?? null],
    );
    return orgOut((await one('SELECT * FROM orgs WHERE id = $1', [org]))!, role);
  });

  app.delete('/orgs/:org', async (req, reply) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'owner');
    const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM workspaces WHERE org_id = $1', [org]);
    if (n!.n > 0) throw conflict('detach or delete the organization\'s workspaces first');
    await q('DELETE FROM orgs WHERE id = $1', [org]);
    return reply.status(204).send();
  });

  // Members ---------------------------------------------------------------------------------
  app.get('/orgs/:org/members', async (req) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org);
    const rows = await q(
      `SELECT u.id, u.email, u.name, u.totp_enabled_at IS NOT NULL AS mfa, m.role, m.created_at,
         EXISTS (SELECT 1 FROM scim_users s WHERE s.org_id = m.org_id AND s.user_id = u.id) AS scim,
         EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'saml' AND i.subject LIKE m.org_id || ':%') AS saml
       FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
      [org],
    );
    const invites = await q('SELECT * FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at', [org]);
    return {
      items: rows.map((r) => ({ userId: r.id, email: r.email, name: r.name, role: r.role, mfaEnabled: r.mfa, scimManaged: r.scim, samlLinked: r.saml, createdAt: r.created_at })),
      invites: invites.map(orgInviteOut),
      nextCursor: null,
    };
  });

  /**
   * Invites someone by email. Nobody joins an organization without accepting (an org admin gains power over the
   * workspaces members bring along), and the answer is the same whether or not a NAV account uses the address.
   */
  app.post('/orgs/:org/members', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { org } = req.params as { org: string };
    const myRole = await orgRole(req, org, 'admin');
    const body = z.object({ email: z.string().trim().toLowerCase().email(), role: OrgRoleSchema.default('member') }).parse(req.body);
    if (body.role === 'owner' && myRole !== 'owner') throw badRequest('only owners can invite owners');
    const pending = await one<{ n: number }>('SELECT count(*)::int AS n FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()', [org]);
    if ((pending?.n ?? 0) >= MAX_PENDING_ORG_INVITES) throw new HttpError(429, 'invite_limit', `this organization has ${pending!.n} pending invitations; revoke some first`);
    const me = requireUser(req);
    const invite = (await one(
      `INSERT INTO org_invites (id, org_id, email, role, invited_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, lower(email)) WHERE accepted_at IS NULL
       DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, created_at = now(), expires_at = now() + interval '14 days'
       RETURNING *`,
      [id('oin'), org, body.email, body.role, me.id],
    ))!;
    const orgRow = await one('SELECT name FROM orgs WHERE id = $1', [org]);
    void sendMail({
      to: body.email,
      subject: `You're invited to ${orgRow?.name ?? 'an organization'} on NAV`,
      ...layout(`Join ${orgRow?.name ?? 'the organization'} on NAV`, [
        `${me.name} invited you to join as ${body.role}.`,
        'Sign in (or sign up) with this email address and accept the invitation under Account settings. Nothing changes until you accept.',
      ], { label: 'Review the invitation', url: `${config.dashboardUrl}/account#org-invites` }),
    }).catch((e) => console.error('[mail]', e.message));
    return reply.status(202).send({ invite: orgInviteOut(invite) });
  });

  app.delete('/orgs/:org/invites/:inviteId', async (req, reply) => {
    const { org, inviteId } = req.params as { org: string; inviteId: string };
    await orgRole(req, org, 'admin');
    await q('DELETE FROM org_invites WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL', [inviteId, org]);
    return reply.status(204).send();
  });

  // The invitee's side: pending invitations for the caller's (verified) email, accepted or declined explicitly.
  app.get('/org-invites', async (req) => {
    const me = await one('SELECT email, email_verified_at FROM users WHERE id = $1', [requireUser(req).id]);
    if (!me?.email_verified_at) return { items: [], emailVerified: false };
    const rows = await q(
      `SELECT i.*, o.name AS org_name FROM org_invites i JOIN orgs o ON o.id = i.org_id
       WHERE lower(i.email) = lower($1) AND i.accepted_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
      [me.email],
    );
    return { items: rows.map((r) => ({ ...orgInviteOut(r), orgId: r.org_id, orgName: r.org_name })), emailVerified: true };
  });

  const myInvite = async (req: FastifyRequest) => {
    const user = requireUser(req);
    const me = await one('SELECT email, email_verified_at FROM users WHERE id = $1', [user.id]);
    const inv = await one('SELECT * FROM org_invites WHERE id = $1 AND accepted_at IS NULL AND expires_at > now()', [(req.params as { inviteId: string }).inviteId]);
    if (!inv || !me || inv.email.toLowerCase() !== String(me.email).toLowerCase()) throw notFound('invitation');
    if (!me.email_verified_at) throw new HttpError(403, 'email_unverified', 'verify your email address before accepting invitations');
    req.auditOrgId = inv.org_id;
    return { user, inv };
  };

  app.post('/org-invites/:inviteId/accept', async (req) => {
    const { user, inv } = await myInvite(req);
    const ok = await tx(async (c) => {
      const claimed = await c.query('UPDATE org_invites SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING id', [inv.id]);
      if (!claimed.rowCount) return false;
      // Accepting never lowers or raises an existing membership.
      await c.query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO NOTHING', [inv.org_id, user.id, inv.role]);
      return true;
    });
    if (!ok) throw notFound('invitation');
    return { ok: true, orgId: inv.org_id, role: inv.role };
  });

  app.post('/org-invites/:inviteId/decline', async (req, reply) => {
    const { inv } = await myInvite(req);
    await q('DELETE FROM org_invites WHERE id = $1 AND accepted_at IS NULL', [inv.id]);
    return reply.status(204).send();
  });

  app.patch('/orgs/:org/members/:userId', async (req) => {
    const { org, userId } = req.params as { org: string; userId: string };
    const myRole = await orgRole(req, org, 'admin');
    const { role } = z.object({ role: OrgRoleSchema }).parse(req.body);
    const target = await one('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [org, userId]);
    if (!target) throw notFound('member');
    if ((role === 'owner' || target.role === 'owner') && myRole !== 'owner') throw badRequest('only owners can grant or change owner');
    await assertNotLastOrgOwner(org, userId, role);
    await q('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [org, userId, role]);
    return { ok: true };
  });

  /** Removes a member from the org and from every workspace the org owns. */
  app.delete('/orgs/:org/members/:userId', async (req, reply) => {
    const { org, userId } = req.params as { org: string; userId: string };
    const myRole = await orgRole(req, org, userId === requireUser(req).id ? 'member' : 'admin');
    const target = await one('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [org, userId]);
    if (!target) throw notFound('member');
    if (target.role === 'owner' && myRole !== 'owner') throw forbidden('only owners can remove an owner');
    await assertNotLastOrgOwner(org, userId, null);
    await tx(async (c) => {
      await c.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [org, userId]);
      await c.query('DELETE FROM workspace_members WHERE user_id = $2 AND workspace_id IN (SELECT id FROM workspaces WHERE org_id = $1)', [org, userId]);
    });
    return reply.status(204).send();
  });

  // Workspaces ------------------------------------------------------------------------------
  app.get('/orgs/:org/workspaces', async (req) => {
    const { org } = req.params as { org: string };
    const role = await orgRole(req, org);
    const me = requireUser(req).id;
    // Members see the org's workspaces they belong to; admins see all of them.
    const rows = await q(
      `SELECT w.*, (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
         (SELECT count(*)::int FROM services s WHERE s.workspace_id = w.id) AS services,
         (SELECT count(*)::int FROM databases d WHERE d.workspace_id = w.id) AS databases
       FROM workspaces w WHERE w.org_id = $1 AND ($2 OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = $3))
       ORDER BY w.created_at`,
      [org, role !== 'member', me],
    );
    return { items: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, members: r.members, services: r.services, databases: r.databases, requireTwoFactor: r.require_2fa, createdAt: r.created_at })), nextCursor: null };
  });

  app.post('/orgs/:org/workspaces', async (req, reply) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    const { name } = z.object({ name: Name }).parse(req.body);
    const wsId = id('ws');
    await tx(async (c) => {
      await c.query('INSERT INTO workspaces (id, name, slug, org_id) VALUES ($1,$2,$3,$4)', [wsId, name, await uniqueSlug(c, 'workspaces', name), org]);
      await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [wsId, requireUser(req).id]);
    });
    return reply.status(201).send({ id: wsId, name, orgId: org });
  });

  /** Moves a workspace the caller owns into the org. */
  app.post('/orgs/:org/workspaces/:workspaceId/attach', async (req) => {
    const { org, workspaceId } = req.params as { org: string; workspaceId: string };
    await orgRole(req, org, 'admin');
    if ((await workspaceRole(req, workspaceId, 'owner')) !== 'owner') throw forbidden();
    const ws = await one('SELECT org_id FROM workspaces WHERE id = $1', [workspaceId]);
    if (ws?.org_id) throw conflict(ws.org_id === org ? 'the workspace is already in this organization' : 'that workspace belongs to another organization');
    await q('UPDATE workspaces SET org_id = $2 WHERE id = $1', [workspaceId, org]);
    return { ok: true };
  });

  /** Takes a workspace out of the org (it keeps its own members). Needs an owner who stays behind. */
  app.post('/orgs/:org/workspaces/:workspaceId/detach', async (req) => {
    const { org, workspaceId } = req.params as { org: string; workspaceId: string };
    await orgRole(req, org, 'owner');
    await orgWorkspace(org, workspaceId);
    const owners = await one<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [workspaceId]);
    if (!owners?.n) throw conflict('add an owner to the workspace before detaching it — otherwise nobody could manage it');
    await tx(async (c) => {
      await c.query('UPDATE orgs SET default_workspace_id = NULL WHERE id = $1 AND default_workspace_id = $2', [org, workspaceId]);
      await c.query('UPDATE scim_groups SET workspace_id = NULL WHERE org_id = $1 AND workspace_id = $2', [org, workspaceId]);
      await c.query('UPDATE workspace_members SET scim_managed = false WHERE workspace_id = $1', [workspaceId]);
      await c.query('UPDATE workspaces SET org_id = NULL WHERE id = $1', [workspaceId]);
    });
    return { ok: true };
  });

  // Verified domains ------------------------------------------------------------------------
  app.get('/orgs/:org/domains', async (req) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    return { items: (await q('SELECT * FROM org_domains WHERE org_id = $1 ORDER BY created_at', [org])).map(domainOut) };
  });

  app.post('/orgs/:org/domains', async (req, reply) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    const { domain } = z.object({ domain: z.string().trim().toLowerCase().max(253).regex(DOMAIN_RE, 'enter a domain like example.com') }).parse(req.body);
    const taken = await one('SELECT org_id FROM org_domains WHERE domain = $1 AND verified_at IS NOT NULL', [domain]);
    if (taken) throw conflict(taken.org_id === org ? 'that domain is already verified' : 'that domain is verified by another organization');
    const row = await one('INSERT INTO org_domains (id, org_id, domain, verify_token) VALUES ($1,$2,$3,$4) RETURNING *', [id('dom'), org, domain, newVerifyToken()]);
    return reply.status(201).send(domainOut(row!));
  });

  app.post('/orgs/:org/domains/:domainId/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { org, domainId } = req.params as { org: string; domainId: string };
    await orgRole(req, org, 'admin');
    if (!(await one('SELECT 1 FROM org_domains WHERE id = $1 AND org_id = $2', [domainId, org]))) throw notFound('domain');
    await verifyOrgDomain(domainId);
    return domainOut((await one('SELECT * FROM org_domains WHERE id = $1', [domainId]))!);
  });

  app.delete('/orgs/:org/domains/:domainId', async (req, reply) => {
    const { org, domainId } = req.params as { org: string; domainId: string };
    await orgRole(req, org, 'admin');
    const res = await q('DELETE FROM org_domains WHERE id = $1 AND org_id = $2 RETURNING id', [domainId, org]);
    if (!res.length) throw notFound('domain');
    // SAML cannot stay on without a verified domain to accept users from.
    const left = await one('SELECT 1 FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL', [org]);
    if (!left) await q('UPDATE saml_configs SET enabled = false, enforce = false WHERE org_id = $1', [org]);
    return reply.status(204).send();
  });

  // SAML ------------------------------------------------------------------------------------
  app.get('/orgs/:org/saml', async (req) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    return samlOut(org, await ensureSamlConfig(org));
  });

  app.put('/orgs/:org/saml', async (req) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    const body = z.object({
      metadataXml: z.string().max(200_000).optional(),
      entityId: z.string().trim().max(1000).optional(),
      ssoUrl: z.string().trim().max(2000).optional(),
      certificate: z.string().max(20_000).optional(),
      binding: z.enum(['redirect', 'post']).optional(),
      enabled: z.boolean(),
      enforce: z.boolean().default(false),
    }).parse(req.body);
    const cur = await ensureSamlConfig(org);
    let idp: IdpSettings | null = null;
    try {
      if (body.metadataXml?.trim()) idp = parseIdpMetadata(body.metadataXml);
      else if (body.entityId || body.ssoUrl || body.certificate) {
        idp = body.certificate?.trim()
          ? idpFromFields({ entityId: body.entityId ?? '', ssoUrl: body.ssoUrl ?? '', certificate: body.certificate, binding: body.binding })
          : { ...idpFromFields({ entityId: body.entityId ?? '', ssoUrl: body.ssoUrl ?? '', certificate: (cur.idp_certs as string[])[0] ?? '', binding: body.binding }), certs: cur.idp_certs };
      }
    } catch (err) {
      if (err instanceof SamlError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
    if (idp && body.binding) idp.binding = body.binding;
    const configured = idp ?? (cur.idp_entity_id ? { entityId: cur.idp_entity_id } : null);
    if (body.enabled && !configured) throw badRequest('add your identity provider\'s metadata before turning SAML on');
    if (body.enabled && !(await one('SELECT 1 FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL', [org]))) {
      throw new HttpError(400, 'domain_required', 'verify at least one email domain before turning SAML on');
    }
    if (body.enforce && !body.enabled) throw badRequest('SAML must be on to enforce it');
    if (body.enforce && !cur.enforce) {
      // Enforcing locks verified-domain accounts out of passwords: make sure the admin can still get in.
      const me = requireUser(req);
      const inDomain = await one('SELECT 1 FROM org_domains WHERE org_id = $1 AND domain = $2 AND verified_at IS NOT NULL', [org, emailDomain(me.email)]);
      const tested = await one("SELECT 1 FROM user_identities WHERE user_id = $1 AND provider = 'saml' AND subject LIKE $2 || ':%'", [me.id, org]);
      if (inDomain && !tested) throw new HttpError(400, 'saml_untested', 'sign in with SSO once before enforcing it, so a misconfiguration cannot lock you out');
    }
    await q(
      `UPDATE saml_configs SET enabled = $2, enforce = $3, updated_at = now(),
         idp_entity_id = COALESCE($4, idp_entity_id), idp_sso_url = COALESCE($5, idp_sso_url), idp_certs = COALESCE($6, idp_certs),
         request_binding = COALESCE($7, request_binding)
       WHERE org_id = $1`,
      [org, body.enabled, body.enforce, idp?.entityId ?? null, idp?.ssoUrl ?? null, idp ? JSON.stringify(idp.certs) : null, idp?.binding ?? body.binding ?? null],
    );
    return samlOut(org, (await one('SELECT * FROM saml_configs WHERE org_id = $1', [org]))!);
  });

  app.delete('/orgs/:org/saml', async (req, reply) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    await q('DELETE FROM saml_configs WHERE org_id = $1', [org]);
    await q('DELETE FROM saml_requests WHERE org_id = $1', [org]);
    return reply.status(204).send();
  });

  // SCIM ------------------------------------------------------------------------------------
  app.get('/orgs/:org/scim', async (req) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    const tokens = await q('SELECT t.*, u.email AS created_by_email FROM scim_tokens t LEFT JOIN users u ON u.id = t.created_by WHERE t.org_id = $1 ORDER BY t.created_at DESC', [org]);
    const groups = await q(
      `SELECT g.*, w.name AS workspace_name, (SELECT count(*)::int FROM scim_group_members gm WHERE gm.group_id = g.id) AS members
       FROM scim_groups g LEFT JOIN workspaces w ON w.id = g.workspace_id WHERE g.org_id = $1 ORDER BY g.display_name`,
      [org],
    );
    const users = await one<{ total: number; active: number }>('SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active FROM scim_users WHERE org_id = $1', [org]);
    return {
      baseUrl: scimBaseUrl(),
      tokens: tokens.map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdByEmail: t.created_by_email ?? null, createdAt: t.created_at, lastUsedAt: t.last_used_at })),
      groups: groups.map((g) => ({ id: g.id, displayName: g.display_name, members: g.members, workspaceId: g.workspace_id, workspaceName: g.workspace_name ?? null, role: g.role, updatedAt: g.updated_at })),
      users: { total: users?.total ?? 0, active: users?.active ?? 0 },
    };
  });

  /** A bearer token for the IdP's SCIM connector. Shown once; only its hash is stored. */
  app.post('/orgs/:org/scim/tokens', async (req, reply) => {
    const { org } = req.params as { org: string };
    await orgRole(req, org, 'admin');
    const { name } = z.object({ name: z.string().trim().min(1).max(80).default('SCIM') }).parse(req.body ?? {});
    if (!(await one('SELECT 1 FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL', [org]))) {
      throw new HttpError(400, 'domain_required', 'verify at least one email domain before setting up SCIM');
    }
    const token = `nav_scim_${randomString(40)}`;
    const tokenId = id('sct');
    await q('INSERT INTO scim_tokens (id, org_id, name, token_hash, prefix, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [tokenId, org, name, sha256(token), token.slice(0, 13), requireUser(req).id]);
    return reply.status(201).send({ id: tokenId, name, prefix: token.slice(0, 13), token, baseUrl: scimBaseUrl() });
  });

  app.delete('/orgs/:org/scim/tokens/:tokenId', async (req, reply) => {
    const { org, tokenId } = req.params as { org: string; tokenId: string };
    await orgRole(req, org, 'admin');
    const res = await q('DELETE FROM scim_tokens WHERE id = $1 AND org_id = $2 RETURNING id', [tokenId, org]);
    if (!res.length) throw notFound('token');
    return reply.status(204).send();
  });

  /** Maps a SCIM group to a role in one of the org's workspaces (or clears the mapping). */
  app.patch('/orgs/:org/scim/groups/:groupId', async (req) => {
    const { org, groupId } = req.params as { org: string; groupId: string };
    await orgRole(req, org, 'admin');
    const body = z.object({ workspaceId: z.string().max(64).nullable(), role: WsRole.nullable() }).parse(req.body);
    if (!!body.workspaceId !== !!body.role) throw badRequest('choose both a workspace and a role, or neither');
    if (body.workspaceId) await orgWorkspace(org, body.workspaceId);
    const prev = await one('SELECT workspace_id FROM scim_groups WHERE id = $1 AND org_id = $2', [groupId, org]);
    if (!prev) throw notFound('group');
    await q('UPDATE scim_groups SET workspace_id = $3, role = $4, updated_at = now() WHERE id = $1 AND org_id = $2', [groupId, org, body.workspaceId, body.role]);
    await syncGroup(groupId);
    if (prev.workspace_id && prev.workspace_id !== body.workspaceId) await syncOrgGroups(org, [prev.workspace_id]);
    return { ok: true };
  });
}
