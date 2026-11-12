import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { HttpError } from '../lib/core.ts';
import { authenticate } from './auth.ts';
import { authRoutes } from './routes/auth.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { serviceRoutes } from './routes/services.ts';
import { workflowRoutes } from './routes/workflows.ts';
import { databaseRoutes } from './routes/databases.ts';
import { databaseFeatureRoutes } from './routes/databaseFeatures.ts';
import { envGroupRoutes } from './routes/envgroups.ts';
import { blueprintRoutes } from './routes/blueprints.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { githubAppRoutes } from './routes/githubApp.ts';
import { internalRoutes } from './routes/internal.ts';
import { mfaRoutes } from './routes/mfa.ts';
import { attachShellRelay } from './shell.ts';
import { keyValueRoutes } from './routes/keyvalue.ts';
import { registryRoutes } from './routes/registries.ts';
import { streamRoutes } from './routes/streams.ts';
import { snapshotRoutes } from './routes/snapshots.ts';
import { outboundWebhookRoutes } from './routes/outboundWebhooks.ts';
import { auditRoutes, recordAudit } from './routes/audit.ts';
import { platformRoutes } from './routes/platform.ts';
import { orgRoutes } from './routes/orgs.ts';
import { samlRoutes } from './routes/saml.ts';
import { scimRoutes } from './routes/scim.ts';
import { usageRoutes } from './routes/usage.ts';
import { sandboxRoutes } from './routes/sandboxes.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAML_ACS = /^\/api\/v1\/auth\/saml\/[\w-]+\/acs$/;
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

/**
 * NAV_TRUST_PROXY: '1' trusts every proxy hop; an address list such as '127.0.0.1' (behind the NAV edge on the
 * same host) trusts only those, so the client IP and https scheme come from the edge's X-Forwarded-* headers and a
 * client cannot spoof them. Unset or '0': ignore forwarding headers.
 */
export function trustProxySetting(v: string | undefined): boolean | string {
  const s = (v ?? '').trim();
  if (s === '' || s === '0') return false;
  return s === '1' ? true : s;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.NAV_LOG_LEVEL ?? 'warn' },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: trustProxySetting(process.env.NAV_TRUST_PROXY),
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new HttpError(400, 'bad_json', 'request body is not valid JSON'), undefined);
    }
  });

  app.decorateRequest('user', null);
  app.decorateRequest('authKind', null);
  app.decorateRequest('tokenWorkspaceId', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (!req.url.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    await authenticate(req);
    // CSRF: cookie-authenticated mutations must carry a custom header (cannot be sent cross-site without CORS).
    // The SAML ACS is posted by the IdP's form; it is authenticated by the signed, single-use assertion instead.
    if (req.authKind === 'session' && !SAFE.has(req.method) && req.headers['x-nav-csrf'] !== '1' && !SAML_ACS.test(req.url.split('?')[0])) {
      throw new HttpError(403, 'csrf', 'missing X-NAV-CSRF header');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.user && !SAFE.has(req.method) && reply.statusCode < 400 && req.url.startsWith('/api/v1/')) await recordAudit(req).catch(() => {});
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.join('.') || 'body';
      return reply.status(400).send({ error: { code: 'validation_error', message: `${where}: ${issue?.message}`, details: err.issues } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    }
    if ((e as { code?: string }).code === '23505') {
      return reply.status(409).send({ error: { code: 'conflict', message: 'a resource with that name already exists' } });
    }
    req.log.error(err);
    console.error('[api]', req.method, req.url, err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });

  app.get('/healthz', async () => ({ ok: true }));
  attachShellRelay(app);

  await app.register(
    async (api) => {
      await authRoutes(api);
      await mfaRoutes(api);
      await auditRoutes(api);
      await outboundWebhookRoutes(api);
      await keyValueRoutes(api);
      await registryRoutes(api);
      await streamRoutes(api);
      await snapshotRoutes(api);
      await workspaceRoutes(api);
      await serviceRoutes(api);
      await workflowRoutes(api);
      await databaseRoutes(api);
      await databaseFeatureRoutes(api);
      await envGroupRoutes(api);
      await blueprintRoutes(api);
      await webhookRoutes(api);
      await githubAppRoutes(api);
      await platformRoutes(api);
      await orgRoutes(api);
      await usageRoutes(api);
      // Encapsulated: adds a form-body parser for the IdP's POST.
      await api.register(samlRoutes);
      // Encapsulated: adds a raw-body parser for file uploads.
      await api.register(sandboxRoutes);
    },
    { prefix: '/api/v1' },
  );

  await app.register(scimRoutes, { prefix: '/scim/v2' });

  await app.register(internalRoutes, { prefix: '/internal/v1' });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'route not found' } });
    // Production: serve the built dashboard SPA.
    if (!existsSync(webDist)) return reply.status(404).send('Dashboard not built. Run: npm run build -w @nav/web');
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(webDist, '.' + rel);
    if (file.startsWith(webDist) && existsSync(file) && !file.endsWith(path.sep) && path.extname(file)) {
      const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.html': 'text/html' };
      reply.header('cache-control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.type(types[path.extname(file)] ?? 'application/octet-stream').send(await readFile(file));
    }
    return reply.type('text/html').header('cache-control', 'no-cache').send(await readFile(path.join(webDist, 'index.html')));
  });

  return app;
}
