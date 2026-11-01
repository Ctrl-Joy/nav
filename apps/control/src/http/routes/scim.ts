// SCIM 2.0 provisioning (RFC 7643/7644, the subset Okta and Microsoft Entra use), mounted at /scim/v2.
// Authenticated by a per-org bearer token (stored hashed). Users must have an email in one of the org's verified
// domains. Deactivating or deleting a user removes them from the org and its workspaces and revokes their sessions
// and API keys. Groups can be mapped to a workspace role from the org settings. Every change is audited.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { one, q, tx, type Client, type Row } from '../../db/pool.ts';
import { HttpError } from '../../lib/core.ts';
import { claimAccount, deprovisionOrgUser, emailDomain, orgHasVerifiedDomain, provisionOrgUser, syncGroupRoles } from '../../lib/orgs.ts';
import {
  SCHEMA_GROUP, SCHEMA_USER, ScimError, applyUserPatch, errorBody, listResponse, paging, parseFilter, parseGroupPatch, resourceTypes,
  schemas, serviceProviderConfig, userFromResource, type UserState,
} from '../../lib/scim.ts';
import { writeAudit } from './audit.ts';
import { scimBaseUrl } from './orgs.ts';

declare module 'fastify' {
  interface FastifyRequest {
    scim: { orgId: string; tokenId: string; tokenName: string } | null;
  }
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function ctx(req: FastifyRequest) {
  return req.scim!;
}

async function audit(req: FastifyRequest, action: string, targetType: string, targetId: string, data: Record<string, unknown>) {
  const s = ctx(req);
  await writeAudit({
    orgId: s.orgId, actorKind: 'scim', actorEmail: `scim:${s.tokenName}`, action, targetType, targetId, ip: req.ip,
    userAgent: String(req.headers['user-agent'] ?? ''), data: { tokenId: s.tokenId, ...data },
  });
}

// ---- Users ------------------------------------------------------------------------------------

const USER_SQL = `SELECT su.*, u.email FROM scim_users su JOIN users u ON u.id = su.user_id`;

async function userGroups(scimUserId: string) {
  return q('SELECT g.id, g.display_name FROM scim_group_members gm JOIN scim_groups g ON g.id = gm.group_id WHERE gm.scim_user_id = $1 ORDER BY g.display_name', [scimUserId]);
}

function userOut(r: Row, groups: Row[] = []) {
  const formatted = [r.given_name, r.family_name].filter(Boolean).join(' ') || null;
  return {
    schemas: [SCHEMA_USER],
    id: r.id,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    userName: r.user_name,
    name: { ...(r.given_name ? { givenName: r.given_name } : {}), ...(r.family_name ? { familyName: r.family_name } : {}), ...(formatted ? { formatted } : {}) },
    displayName: r.display_name ?? formatted ?? r.user_name,
    emails: [{ value: r.email, type: 'work', primary: true }],
    active: r.active,
    groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${scimBaseUrl()}/Groups/${g.id}` })),
    meta: { resourceType: 'User', created: r.created_at, lastModified: r.updated_at, location: `${scimBaseUrl()}/Users/${r.id}` },
  };
}

function stateOf(r: Row): UserState {
  return { userName: r.user_name, externalId: r.external_id, givenName: r.given_name, familyName: r.family_name, displayName: r.display_name, email: r.email, active: r.active };
}

async function loadUser(orgId: string, scimId: string): Promise<Row> {
  const row = await one(`${USER_SQL} WHERE su.org_id = $1 AND su.id = $2`, [orgId, scimId]);
  if (!row) throw new ScimError(404, `User ${scimId} not found`);
  return row;
}

/** The address the account is matched on: the primary email, else a userName that is an email. */
function emailOf(s: UserState): string {
  const email = s.email ?? (looksLikeEmail(s.userName) ? s.userName.toLowerCase() : null);
  if (!email || !looksLikeEmail(email)) throw new ScimError(400, 'the user needs an email address (emails or an email userName)', 'invalidValue');
  return email;
}

async function assertDomain(orgId: string, email: string) {
  if (!(await orgHasVerifiedDomain(orgId, email))) throw new ScimError(400, `${emailDomain(email)} is not a verified domain of this organization`, 'invalidValue');
}

const displayName = (s: UserState) => s.displayName ?? ([s.givenName, s.familyName].filter(Boolean).join(' ') || s.userName.split('@')[0]);

/** Writes a new state for an existing SCIM user and applies (de)provisioning. Returns what changed for the audit log. */
async function saveUser(c: Client, orgId: string, row: Row, next: UserState): Promise<Record<string, unknown>> {
  const changes: Record<string, unknown> = {};
  if (next.userName.toLowerCase() !== String(row.user_name).toLowerCase()) {
    const dup = (await c.query('SELECT 1 FROM scim_users WHERE org_id = $1 AND lower(user_name) = lower($2) AND id <> $3', [orgId, next.userName, row.id])).rowCount;
    if (dup) throw new ScimError(409, 'userName is already in use', 'uniqueness');
    changes.userName = next.userName;
  }
  const email = emailOf(next);
  if (email !== row.email) {
    // Only addresses the org owns; the account keeps its id, so its memberships follow it.
    await assertDomain(orgId, email);
    if ((await c.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [email, row.user_id])).rowCount) throw new ScimError(409, 'another account already uses that email', 'uniqueness');
    if (!(await orgHasVerifiedDomain(orgId, row.email))) throw new ScimError(400, 'the account\'s current email is outside the organization\'s verified domains', 'mutability');
    await c.query('UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1', [row.user_id, email]);
    changes.email = email;
  }
  await c.query(
    `UPDATE scim_users SET user_name = $2, external_id = $3, given_name = $4, family_name = $5, display_name = $6, active = $7, updated_at = now() WHERE id = $1`,
    [row.id, next.userName, next.externalId, next.givenName, next.familyName, next.displayName, next.active],
  );
  if (next.displayName || next.givenName || next.familyName) await c.query('UPDATE users SET name = $2 WHERE id = $1', [row.user_id, displayName(next).slice(0, 100)]);
  if (row.active && !next.active) {
    await deprovisionOrgUser(c, orgId, row.user_id);
    changes.active = false;
  } else if (!row.active && next.active) {
    await provisionOrgUser(c, orgId, row.user_id);
    changes.active = true;
  }
  return changes;
}

// ---- Groups -----------------------------------------------------------------------------------

async function groupMembers(groupId: string) {
  return q('SELECT su.id, su.user_name FROM scim_group_members gm JOIN scim_users su ON su.id = gm.scim_user_id WHERE gm.group_id = $1 ORDER BY su.user_name', [groupId]);
}

function groupOut(r: Row, members: Row[] | null) {
  return {
    schemas: [SCHEMA_GROUP],
    id: r.id,
    displayName: r.display_name,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    ...(members ? { members: members.map((m) => ({ value: m.id, display: m.user_name, $ref: `${scimBaseUrl()}/Users/${m.id}` })) } : {}),
    meta: { resourceType: 'Group', created: r.created_at, lastModified: r.updated_at, location: `${scimBaseUrl()}/Groups/${r.id}` },
  };
}

async function loadGroup(orgId: string, groupId: string): Promise<Row> {
  const row = await one('SELECT * FROM scim_groups WHERE org_id = $1 AND id = $2', [orgId, groupId]);
  if (!row) throw new ScimError(404, `Group ${groupId} not found`);
  return row;
}

/** Applies member changes and re-syncs workspace roles for everyone affected. */
async function setMembers(c: Client, orgId: string, groupId: string, change: { add: string[]; remove: string[]; replace?: string[] }) {
  const ids = [...new Set([...change.add, ...change.remove, ...(change.replace ?? [])])];
  if (ids.length) {
    const known = (await c.query('SELECT id FROM scim_users WHERE org_id = $1 AND id = ANY($2::text[])', [orgId, ids])).rows.map((r) => r.id);
    const unknown = [...change.add, ...(change.replace ?? [])].filter((m) => !known.includes(m));
    if (unknown.length) throw new ScimError(400, `unknown member ${unknown[0]}`, 'invalidValue');
  }
  const before = (await c.query('SELECT scim_user_id FROM scim_group_members WHERE group_id = $1', [groupId])).rows.map((r) => r.scim_user_id as string);
  if (change.replace) await c.query('DELETE FROM scim_group_members WHERE group_id = $1', [groupId]);
  for (const m of change.replace ?? []) await c.query('INSERT INTO scim_group_members (group_id, scim_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [groupId, m]);
  for (const m of change.add) await c.query('INSERT INTO scim_group_members (group_id, scim_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [groupId, m]);
  if (change.remove.length) await c.query('DELETE FROM scim_group_members WHERE group_id = $1 AND scim_user_id = ANY($2::text[])', [groupId, change.remove]);
  const affected = [...new Set([...before, ...ids])];
  const users = (await c.query('SELECT user_id FROM scim_users WHERE id = ANY($1::text[])', [affected])).rows;
  for (const u of users) await syncGroupRoles(c, orgId, u.user_id);
}

// ---- Plugin -----------------------------------------------------------------------------------

export async function scimRoutes(app: FastifyInstance) {
  app.decorateRequest('scim', null);
  // IdPs send application/scim+json (and some plain JSON); errors must come back in the SCIM error format.
  app.removeContentTypeParser('application/json');
  for (const type of ['application/scim+json', 'application/json']) {
    app.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
      if (!(body as string).length) return done(null, {});
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(new ScimError(400, 'request body is not valid JSON', 'invalidSyntax'), undefined);
      }
    });
  }

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const row = token ? await one('UPDATE scim_tokens SET last_used_at = now() WHERE token_hash = $1 RETURNING id, org_id, name', [sha256(token)]) : null;
    if (!row) throw new ScimError(401, 'a valid SCIM bearer token is required');
    req.scim = { orgId: row.org_id, tokenId: row.id, tokenName: row.name };
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode !== 204) reply.type('application/scim+json; charset=utf-8');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    let e: ScimError;
    if (err instanceof ScimError) e = err;
    else if (err instanceof HttpError) e = new ScimError(err.status, err.message);
    else if ((err as { code?: string }).code === '23505') e = new ScimError(409, 'a resource with that value already exists', 'uniqueness');
    else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) e = new ScimError((err as { statusCode: number }).statusCode, (err as Error).message);
    else {
      console.error('[scim]', req.method, req.url, err);
      e = new ScimError(500, 'internal server error');
    }
    return reply.status(e.status).type('application/scim+json; charset=utf-8').send(errorBody(e));
  });

  // Discovery
  app.get('/ServiceProviderConfig', async () => serviceProviderConfig(scimBaseUrl()));
  app.get('/ResourceTypes', async () => listResponse(resourceTypes(scimBaseUrl()), 2, 1));
  app.get('/ResourceTypes/:name', async (req) => {
    const t = resourceTypes(scimBaseUrl()).find((r) => r.id === (req.params as { name: string }).name);
    if (!t) throw new ScimError(404, 'resource type not found');
    return t;
  });
  app.get('/Schemas', async () => listResponse(schemas(scimBaseUrl()), 2, 1));
  app.get('/Schemas/:id', async (req) => {
    const s = schemas(scimBaseUrl()).find((r) => r.id === (req.params as { id: string }).id);
    if (!s) throw new ScimError(404, 'schema not found');
    return s;
  });

  // Users
  app.get('/Users', async (req) => {
    const { orgId } = ctx(req);
    const qs = req.query as { filter?: string; startIndex?: string; count?: string };
    const f = parseFilter(qs.filter, ['userName', 'externalId', 'emails.value', 'emails']);
    const page = paging(qs);
    const col = f ? { userName: 'lower(su.user_name) = lower($2)', externalId: 'su.external_id = $2', 'emails.value': 'u.email = lower($2)', emails: 'u.email = lower($2)' }[f.attr] : 'true';
    const params: unknown[] = [orgId, f?.value ?? null];
    const total = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM scim_users su JOIN users u ON u.id = su.user_id WHERE su.org_id = $1 AND ($2::text IS NULL OR ${col})`, params))!.n;
    const rows = await q(`${USER_SQL} WHERE su.org_id = $1 AND ($2::text IS NULL OR ${col}) ORDER BY su.created_at LIMIT $3 OFFSET $4`, [...params, page.limit, page.offset]);
    const out = [];
    for (const r of rows) out.push(userOut(r, await userGroups(r.id)));
    return listResponse(out, total, page.startIndex);
  });

  app.get('/Users/:id', async (req) => {
    const row = await loadUser(ctx(req).orgId, (req.params as { id: string }).id);
    return userOut(row, await userGroups(row.id));
  });

  app.post('/Users', async (req, reply: FastifyReply) => {
    const { orgId } = ctx(req);
    const s = userFromResource(req.body);
    const email = emailOf(s);
    await assertDomain(orgId, email);
    if (await one('SELECT 1 FROM scim_users WHERE org_id = $1 AND lower(user_name) = lower($2)', [orgId, s.userName])) throw new ScimError(409, 'userName is already in use', 'uniqueness');
    const scimId = id('scu');
    const result = await tx(async (c) => {
      const claimed = await claimAccount(c, email, displayName(s));
      if ((await c.query('SELECT 1 FROM scim_users WHERE org_id = $1 AND user_id = $2', [orgId, claimed.userId])).rowCount) {
        throw new ScimError(409, 'this account is already provisioned under another userName', 'uniqueness');
      }
      await c.query(
        `INSERT INTO scim_users (id, org_id, user_id, user_name, external_id, given_name, family_name, display_name, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [scimId, orgId, claimed.userId, s.userName, s.externalId, s.givenName, s.familyName, s.displayName, s.active],
      );
      if (s.active) await provisionOrgUser(c, orgId, claimed.userId);
      else await deprovisionOrgUser(c, orgId, claimed.userId);
      return claimed;
    });
    await audit(req, 'scim.user.create', 'user', result.userId, { scimId, userName: s.userName, email, active: s.active, created: result.created, tookOverUnverifiedAccount: result.tookOver });
    const row = await loadUser(orgId, scimId);
    return reply.status(201).header('location', `${scimBaseUrl()}/Users/${scimId}`).send(userOut(row, []));
  });

  const update = async (req: FastifyRequest, next: (row: Row) => UserState) => {
    const { orgId } = ctx(req);
    const row = await loadUser(orgId, (req.params as { id: string }).id);
    const state = next(row);
    const changes = await tx((c) => saveUser(c, orgId, row, state));
    const action = changes.active === false ? 'scim.user.deactivate' : changes.active === true ? 'scim.user.reactivate' : 'scim.user.update';
    await audit(req, action, 'user', row.user_id, { scimId: row.id, userName: state.userName, changes });
    const fresh = await loadUser(orgId, row.id);
    return userOut(fresh, await userGroups(fresh.id));
  };

  app.put('/Users/:id', async (req) => update(req, () => userFromResource(req.body)));
  app.patch('/Users/:id', async (req) => update(req, (row) => applyUserPatch(stateOf(row), req.body)));

  app.delete('/Users/:id', async (req, reply) => {
    const { orgId } = ctx(req);
    const row = await loadUser(orgId, (req.params as { id: string }).id);
    await tx(async (c) => {
      await deprovisionOrgUser(c, orgId, row.user_id);
      await c.query('DELETE FROM scim_users WHERE id = $1', [row.id]);
      await syncGroupRoles(c, orgId, row.user_id);
    });
    await audit(req, 'scim.user.delete', 'user', row.user_id, { scimId: row.id, userName: row.user_name });
    return reply.status(204).send();
  });

  // Groups
  app.get('/Groups', async (req) => {
    const { orgId } = ctx(req);
    const qs = req.query as { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string };
    const f = parseFilter(qs.filter, ['displayName', 'externalId']);
    const page = paging(qs);
    const col = f ? (f.attr === 'displayName' ? 'lower(display_name) = lower($2)' : 'external_id = $2') : 'true';
    const total = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM scim_groups WHERE org_id = $1 AND ($2::text IS NULL OR ${col})`, [orgId, f?.value ?? null]))!.n;
    const rows = await q(`SELECT * FROM scim_groups WHERE org_id = $1 AND ($2::text IS NULL OR ${col}) ORDER BY created_at LIMIT $3 OFFSET $4`, [orgId, f?.value ?? null, page.limit, page.offset]);
    const withMembers = !/\bmembers\b/i.test(qs.excludedAttributes ?? '');
    const out = [];
    for (const r of rows) out.push(groupOut(r, withMembers ? await groupMembers(r.id) : null));
    return listResponse(out, total, page.startIndex);
  });

  app.get('/Groups/:id', async (req) => {
    const row = await loadGroup(ctx(req).orgId, (req.params as { id: string }).id);
    const qs = req.query as { excludedAttributes?: string };
    return groupOut(row, /\bmembers\b/i.test(qs.excludedAttributes ?? '') ? null : await groupMembers(row.id));
  });

  const groupBody = (body: unknown) => {
    const b = (body ?? {}) as { displayName?: unknown; externalId?: unknown; members?: unknown };
    if (typeof b.displayName !== 'string' || !b.displayName.trim()) throw new ScimError(400, 'displayName is required', 'invalidValue');
    const members = Array.isArray(b.members) ? b.members.map((m) => String((m as { value?: unknown })?.value ?? '')) : [];
    return { displayName: b.displayName.trim().slice(0, 200), externalId: typeof b.externalId === 'string' ? b.externalId : null, members };
  };

  app.post('/Groups', async (req, reply) => {
    const { orgId } = ctx(req);
    const g = groupBody(req.body);
    if (await one('SELECT 1 FROM scim_groups WHERE org_id = $1 AND lower(display_name) = lower($2)', [orgId, g.displayName])) throw new ScimError(409, 'a group with that displayName exists', 'uniqueness');
    const groupId = id('scg');
    await tx(async (c) => {
      await c.query('INSERT INTO scim_groups (id, org_id, display_name, external_id) VALUES ($1,$2,$3,$4)', [groupId, orgId, g.displayName, g.externalId]);
      await setMembers(c, orgId, groupId, { add: g.members, remove: [] });
    });
    await audit(req, 'scim.group.create', 'scim_group', groupId, { displayName: g.displayName, members: g.members.length });
    const row = await loadGroup(orgId, groupId);
    return reply.status(201).header('location', `${scimBaseUrl()}/Groups/${groupId}`).send(groupOut(row, await groupMembers(groupId)));
  });

  app.put('/Groups/:id', async (req) => {
    const { orgId } = ctx(req);
    const row = await loadGroup(orgId, (req.params as { id: string }).id);
    const g = groupBody(req.body);
    await tx(async (c) => {
      await c.query('UPDATE scim_groups SET display_name = $2, external_id = $3, updated_at = now() WHERE id = $1', [row.id, g.displayName, g.externalId]);
      await setMembers(c, orgId, row.id, { add: [], remove: [], replace: g.members });
    });
    await audit(req, 'scim.group.update', 'scim_group', row.id, { displayName: g.displayName, members: g.members.length });
    return groupOut((await loadGroup(orgId, row.id)), await groupMembers(row.id));
  });

  app.patch('/Groups/:id', async (req, reply) => {
    const { orgId } = ctx(req);
    const row = await loadGroup(orgId, (req.params as { id: string }).id);
    const p = parseGroupPatch(req.body);
    await tx(async (c) => {
      if (p.displayName !== undefined || p.externalId !== undefined) {
        await c.query('UPDATE scim_groups SET display_name = COALESCE($2, display_name), external_id = CASE WHEN $3 THEN $4 ELSE external_id END, updated_at = now() WHERE id = $1', [
          row.id, p.displayName ?? null, p.externalId !== undefined, p.externalId ?? null,
        ]);
      } else await c.query('UPDATE scim_groups SET updated_at = now() WHERE id = $1', [row.id]);
      await setMembers(c, orgId, row.id, p);
    });
    await audit(req, 'scim.group.update', 'scim_group', row.id, { displayName: p.displayName, added: p.add, removed: p.remove, replaced: p.replace?.length });
    return reply.status(204).send();
  });

  app.delete('/Groups/:id', async (req, reply) => {
    const { orgId } = ctx(req);
    const row = await loadGroup(orgId, (req.params as { id: string }).id);
    await tx(async (c) => {
      const members = (await c.query('SELECT su.user_id FROM scim_group_members gm JOIN scim_users su ON su.id = gm.scim_user_id WHERE gm.group_id = $1', [row.id])).rows;
      await c.query('DELETE FROM scim_groups WHERE id = $1', [row.id]);
      for (const m of members) await syncGroupRoles(c, orgId, m.user_id);
      // Its workspace may no longer be mapped by any group: drop the memberships the mapping created there.
      if (row.workspace_id && !(await c.query('SELECT 1 FROM scim_groups WHERE org_id = $1 AND workspace_id = $2', [orgId, row.workspace_id])).rowCount) {
        await c.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND scim_managed', [row.workspace_id]);
      }
    });
    await audit(req, 'scim.group.delete', 'scim_group', row.id, { displayName: row.display_name });
    return reply.status(204).send();
  });
}
