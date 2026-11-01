// Instance administration: sign-in provider credentials an instance administrator can set from the dashboard
// instead of environment variables. Secrets are write-only: responses say whether one is set, never what it is.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, forbidden, notFound } from '../../lib/core.ts';
import { callbackUrl } from '../../lib/identity.ts';
import { CONFIGURABLE_PROVIDERS, PROVIDER_INFO, clientIdHint, normalizeBaseUrl, testProvider, type ConfigurableProvider } from '../../lib/providerChecks.ts';
import { deleteProvider, effectiveProvider, ensureProviderSettings, isPlatformAdmin, saveProvider, savedProvider } from '../../lib/providerSettings.ts';
import { requireUser } from '../auth.ts';

async function requirePlatformAdmin(req: FastifyRequest) {
  const u = requireUser(req);
  if (!(await isPlatformAdmin(u.id))) throw forbidden('only NAV instance administrators can change sign-in providers');
  return u;
}

function providerParam(req: FastifyRequest): ConfigurableProvider {
  const { provider } = req.params as { provider: string };
  if (!CONFIGURABLE_PROVIDERS.includes(provider as ConfigurableProvider)) throw notFound('provider');
  return provider as ConfigurableProvider;
}

function providerOut(p: ConfigurableProvider) {
  const eff = effectiveProvider(p);
  const saved = savedProvider(p);
  const info = PROVIDER_INFO[p];
  return {
    provider: p,
    name: info.name,
    enabled: eff.enabled,
    /** 'environment' is read-only here; 'database' was saved on this page. */
    source: eff.source,
    readOnly: eff.source === 'environment',
    clientIdHint: clientIdHint(eff.clientId),
    clientSecretSet: !!eff.clientSecret,
    baseUrl: eff.baseUrl,
    callbackUrl: callbackUrl(p),
    scopes: info.scopes,
    envVars: info.envVars,
    /** A saved row exists (it may be shadowed by environment variables, or unreadable). */
    saved: saved ? { updatedAt: saved.updatedAt, updatedBy: saved.updatedBy, unreadable: saved.unreadable } : null,
  };
}

const Save = z.object({
  /** Omitted (or empty): keep the saved one. */
  clientId: z.string().trim().max(256).regex(/^[\x21-\x7e]*$/, 'cannot contain spaces').optional(),
  clientSecret: z.string().trim().max(512).regex(/^[\x21-\x7e]*$/, 'cannot contain spaces').optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
});

const Test = z.object({
  clientId: z.string().trim().max(256).optional(),
  clientSecret: z.string().trim().max(512).optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
});

function readBaseUrl(p: ConfigurableProvider, raw: string | null | undefined): string | null {
  if (p !== 'gitlab' || !raw) return null;
  try {
    return normalizeBaseUrl(raw);
  } catch (err) {
    throw new HttpError(400, 'validation_error', `baseUrl: ${(err as Error).message}`);
  }
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/auth-providers', async (req) => {
    await requirePlatformAdmin(req);
    await ensureProviderSettings();
    return { items: CONFIGURABLE_PROVIDERS.map(providerOut) };
  });

  app.get('/admin/auth-providers/:provider', async (req) => {
    await requirePlatformAdmin(req);
    const p = providerParam(req);
    await ensureProviderSettings();
    return providerOut(p);
  });

  app.put('/admin/auth-providers/:provider', async (req) => {
    const u = await requirePlatformAdmin(req);
    const p = providerParam(req);
    const body = Save.parse(req.body);
    await ensureProviderSettings();
    if (effectiveProvider(p).source === 'environment') {
      throw new HttpError(409, 'managed_by_environment', `${PROVIDER_INFO[p].name} is configured with environment variables on this server; change it there`);
    }
    // Blank fields keep what is saved; secrets are never sent back to the browser, so it can't resend them.
    const existing = savedProvider(p);
    const clientId = body.clientId || existing?.clientId;
    if (!clientId) throw new HttpError(400, 'validation_error', 'clientId: is required');
    if (!body.clientSecret && (!existing || existing.unreadable)) throw new HttpError(400, 'validation_error', 'clientSecret: is required');
    const baseUrl = body.baseUrl === undefined ? (existing?.baseUrl ?? null) : readBaseUrl(p, body.baseUrl);
    await saveProvider(p, { clientId, clientSecret: body.clientSecret || undefined, baseUrl }, u.id);
    return providerOut(p);
  });

  app.delete('/admin/auth-providers/:provider', async (req, reply) => {
    await requirePlatformAdmin(req);
    const p = providerParam(req);
    await ensureProviderSettings();
    if (effectiveProvider(p).source === 'environment') {
      throw new HttpError(409, 'managed_by_environment', `${PROVIDER_INFO[p].name} is configured with environment variables on this server; remove them there`);
    }
    if (!(await deleteProvider(p))) throw notFound('saved provider settings');
    return reply.status(204).send();
  });

  /**
   * Checks credentials without a user: the values in the body (unsaved form), falling back to what is in effect.
   * Calls the provider from this server, so it is rate limited.
   */
  app.post('/admin/auth-providers/:provider/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    await requirePlatformAdmin(req);
    const p = providerParam(req);
    const body = Test.parse(req.body ?? {});
    await ensureProviderSettings();
    const eff = effectiveProvider(p);
    // Typed values only replace saved ones when the provider isn't managed by the environment.
    const useForm = eff.source !== 'environment';
    const creds = {
      clientId: (useForm && body.clientId) || eff.clientId,
      clientSecret: (useForm && body.clientSecret) || eff.clientSecret,
      baseUrl: (useForm && readBaseUrl(p, body.baseUrl)) || eff.baseUrl,
    };
    return testProvider(p, creds, callbackUrl(p));
  });
}
