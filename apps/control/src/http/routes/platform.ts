// Platform administration (installation-wide, not per workspace). Who is an admin is decided in one place:
// isPlatformAdmin in lib/providerSettings.ts (NAV_ADMIN_EMAILS with a verified address, else the first user).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden } from '../../lib/core.ts';
import { ensurePlatformCertificate, platformTlsStatus } from '../../lib/platformTls.ts';
import { isPlatformAdmin } from '../../lib/providerSettings.ts';
import { requireUser, type AuthUser } from '../auth.ts';

async function requirePlatformAdmin(req: FastifyRequest): Promise<AuthUser> {
  const user = requireUser(req);
  if (!(await isPlatformAdmin(user.id))) throw forbidden('platform administrators only');
  return user;
}

export async function platformRoutes(app: FastifyInstance) {
  /** Wildcard certificate for *.<apps domain>: mode, issuer, expiry, last error. */
  app.get('/platform/tls', async (req) => {
    await requirePlatformAdmin(req);
    return platformTlsStatus();
  });

  /** Issue / renew the wildcard now (ignores the 30-day window and the retry back-off). */
  app.post('/platform/tls/renew', async (req, reply) => {
    await requirePlatformAdmin(req);
    const result = await ensurePlatformCertificate({ force: true });
    return reply.status(result === 'enqueued' ? 202 : 200).send({ result, status: await platformTlsStatus() });
  });
}
