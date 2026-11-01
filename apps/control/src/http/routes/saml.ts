// SAML 2.0 service-provider endpoints, one set per org:
//   GET  /api/v1/auth/saml/:org/metadata   SP metadata (entity ID, ACS URL, request-signing certificate)
//   GET  /api/v1/auth/saml/:org/login      starts SP-initiated sign-in (signed AuthnRequest, redirect or POST binding)
//   POST /api/v1/auth/saml/:org/acs        assertion consumer service
// Only SP-initiated sign-in is accepted: every response must answer a request we issued, and each request can be
// answered once. Users are matched to accounts by the email in the assertion, which must be in one of the org's
// verified domains; new users are provisioned just in time. Sessions start through beginSession, so 2FA applies.
import { parse as parseQs } from 'node:querystring';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '@nav/shared/config';
import { decrypt, sha256 } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { one, q, tx } from '../../db/pool.ts';
import { notFound } from '../../lib/core.ts';
import { claimAccount, orgHasVerifiedDomain, provisionOrgUser } from '../../lib/orgs.ts';
import {
  REQUEST_TTL_MS, SamlError, acsUrl, authnRequest, newRequestId, responseInResponseTo, spEntityId, spMetadata, validateResponse,
  type IdpSettings, type SpSettings,
} from '../../lib/saml.ts';
import { beginSession } from './mfa.ts';
import { safeNext } from './auth.ts';
import { writeAudit } from './audit.ts';
import { ensureSamlConfig } from './orgs.ts';

const strict = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
const BIND_COOKIE = 'nav_saml';

function settings(orgId: string, cfg: Record<string, any>): { idp: IdpSettings; sp: SpSettings } {
  return {
    idp: { entityId: cfg.idp_entity_id, ssoUrl: cfg.idp_sso_url, certs: cfg.idp_certs, binding: cfg.request_binding },
    sp: { entityId: spEntityId(orgId), acsUrl: acsUrl(orgId), cert: cfg.sp_cert, key: decrypt(cfg.sp_key_enc) },
  };
}

async function activeConfig(orgId: string) {
  const cfg = await one('SELECT * FROM saml_configs WHERE org_id = $1', [orgId]);
  if (!cfg?.enabled || !cfg.idp_entity_id || !cfg.idp_sso_url || !(cfg.idp_certs as string[]).length) return null;
  return cfg;
}

const fail = (reply: FastifyReply, code: string) => reply.redirect(`${config.dashboardUrl}/login?error=${code}&provider=sso`);

export async function samlRoutes(app: FastifyInstance) {
  // The IdP posts the response as an HTML form (scoped to this plugin).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    done(null, parseQs(body as string));
  });

  app.get('/auth/saml/:org/metadata', async (req, reply) => {
    const { org } = req.params as { org: string };
    if (!(await one('SELECT 1 FROM orgs WHERE id = $1', [org]))) throw notFound('organization');
    const cfg = await ensureSamlConfig(org);
    return reply.type('application/samlmetadata+xml').header('content-disposition', `inline; filename="nav-${org}-metadata.xml"`).send(spMetadata(settings(org, cfg).sp));
  });

  app.get('/auth/saml/:org/login', strict, async (req, reply) => {
    const { org } = req.params as { org: string };
    const { next } = req.query as { next?: string };
    const cfg = await activeConfig(org);
    if (!cfg) return fail(reply, 'saml_not_configured');
    const requestId = newRequestId();
    await q('DELETE FROM saml_requests WHERE expires_at < now()');
    await q('INSERT INTO saml_requests (id, org_id, next, expires_at) VALUES ($1,$2,$3,$4)', [requestId, org, safeNext(next), new Date(Date.now() + REQUEST_TTL_MS)]);
    // Ties the request to this browser, so nobody can complete it with their own assertion in someone else's browser
    // (login CSRF). The IdP posts back cross-site, which needs SameSite=None — and that needs HTTPS.
    const https = req.protocol === 'https';
    reply.setCookie(BIND_COOKIE, sha256(requestId), { path: `/api/v1/auth/saml/${org}`, httpOnly: true, secure: https, sameSite: https ? 'none' : 'lax', maxAge: REQUEST_TTL_MS / 1000 });
    const { idp, sp } = settings(org, cfg);
    try {
      const out = await authnRequest(idp, sp, requestId, '');
      if ('redirect' in out) return reply.redirect(out.redirect);
      return reply.type('text/html; charset=utf-8').send(out.form);
    } catch (err) {
      console.error(`[saml] ${org} login start failed:`, (err as Error).message);
      return fail(reply, 'saml_error');
    }
  });

  app.post('/auth/saml/:org/acs', strict, async (req, reply) => {
    const { org } = req.params as { org: string };
    const body = (req.body ?? {}) as { SAMLResponse?: unknown };
    const ua = String(req.headers['user-agent'] ?? '');
    const denied = async (code: string, detail: string, extra: Record<string, unknown> = {}) => {
      await writeAudit({ orgId: org, actorKind: 'saml', action: 'saml.login_failed', ip: req.ip, userAgent: ua, data: { reason: code, detail: detail.slice(0, 300), ...extra } });
      return fail(reply, code);
    };
    const cfg = await activeConfig(org);
    if (!cfg) return denied('saml_not_configured', 'SAML is off for this organization');
    if (typeof body.SAMLResponse !== 'string' || !body.SAMLResponse) return denied('saml_invalid', 'no SAMLResponse in the request');
    const samlResponse = body.SAMLResponse;

    let requestId: string | null;
    try {
      requestId = responseInResponseTo(samlResponse);
    } catch (err) {
      return denied('saml_invalid', (err as Error).message);
    }
    if (!requestId) return denied('saml_unsolicited', 'IdP-initiated sign-in is not supported; start from NAV');
    const bound = req.cookies[BIND_COOKIE];
    reply.clearCookie(BIND_COOKIE, { path: `/api/v1/auth/saml/${org}` });
    if ((bound || req.protocol === 'https') && bound !== sha256(requestId)) return denied('saml_expired', 'the sign-in was started in a different browser');
    // Each request can be answered once: consuming it here is the replay protection.
    const pending = await one('DELETE FROM saml_requests WHERE id = $1 AND org_id = $2 RETURNING next, created_at, expires_at', [requestId, org]);
    if (!pending || new Date(pending.expires_at) < new Date()) return denied('saml_expired', 'unknown, used or expired sign-in request');

    const { idp, sp } = settings(org, cfg);
    let user;
    try {
      user = await validateResponse({ idp, sp, samlResponse, requestId, requestCreatedAt: new Date(pending.created_at) });
    } catch (err) {
      const e = err as SamlError;
      console.error(`[saml] ${org} rejected a response: ${e.message}`);
      return denied('saml_invalid', e.message ?? 'invalid response', { check: e.code });
    }
    if (!user.email) return denied('saml_no_email', 'the assertion has no email address', { nameId: user.nameId });
    if (!(await orgHasVerifiedDomain(org, user.email))) return denied('saml_domain', `${user.email} is not in a verified domain of this organization`, { email: user.email });

    const subject = `${org}:${user.nameId}`;
    const name = user.displayName ?? ([user.firstName, user.lastName].filter(Boolean).join(' ') || user.email.split('@')[0]);
    let result: { userId: string; created: boolean; tookOver: boolean };
    try {
      result = await tx(async (c) => {
        const ident = (await c.query("SELECT i.user_id, u.email FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'saml' AND i.subject = $1", [subject])).rows[0];
        // A known SAML identity signs in only while the IdP still asserts the account's own address (checked to be
        // in a verified domain above): if the IdP's email for this NameID drifted, the NameID may have been reused.
        if (ident && String(ident.email).toLowerCase() !== user.email!.toLowerCase()) {
          throw new SamlError('saml_email_mismatch', `the identity provider asserted ${user.email}, but this SAML identity belongs to an account with a different email; ask an administrator to update the account or the IdP`);
        }
        const claimed = ident ? { userId: ident.user_id as string, created: false, tookOver: false } : await claimAccount(c, user.email!, name);
        const scim = (await c.query('SELECT active FROM scim_users WHERE org_id = $1 AND user_id = $2', [org, claimed.userId])).rows[0];
        if (scim && !scim.active) throw new SamlError('saml_deprovisioned', 'the account was deprovisioned by the organization');
        await provisionOrgUser(c, org, claimed.userId);
        // One SAML identity per account (UNIQUE user_id, provider): the latest org sign-in wins.
        await c.query("DELETE FROM user_identities WHERE user_id = $1 AND provider = 'saml' AND subject <> $2", [claimed.userId, subject]);
        await c.query(
          `INSERT INTO user_identities (id, user_id, provider, subject, email, username, last_used_at) VALUES ($1,$2,'saml',$3,$4,$5, now())
           ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email, username = EXCLUDED.username, last_used_at = now()`,
          [id('idn'), claimed.userId, subject, user.email, user.nameId.slice(0, 200)],
        );
        return claimed;
      });
    } catch (err) {
      if (err instanceof SamlError) return denied(err.code, err.message, { email: user.email });
      throw err;
    }
    await writeAudit({
      orgId: org, actorId: result.userId, actorEmail: user.email, actorKind: 'saml', action: 'saml.login', targetType: 'user', targetId: result.userId,
      ip: req.ip, userAgent: ua, data: { nameId: user.nameId, sessionIndex: user.sessionIndex, created: result.created, tookOverUnverifiedAccount: result.tookOver },
    });
    const next = safeNext(pending.next);
    if ((await beginSession(req as FastifyRequest, reply, result.userId, next)) === 'mfa') return reply.redirect(`${config.dashboardUrl}/login/mfa`);
    return reply.redirect(`${config.dashboardUrl}${next}`);
  });
}
