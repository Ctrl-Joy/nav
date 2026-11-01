// Platform administration (installation-wide, not per workspace). Platform admins are the emails listed in
// NAV_ADMIN_EMAILS, or the first user who signed up when that is unset.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '@nav/shared/config';
import { one } from '../../db/pool.ts';
import { forbidden } from '../../lib/core.ts';
import { ensurePlatformCertificate, platformTlsStatus } from '../../lib/platformTls.ts';
import { requireUser, type AuthUser } from '../auth.ts';

export async function isPlatformAdmin(user: AuthUser): Promise<boolean> {
  if (config.adminEmails.length) return config.adminEmails.includes(user.email.toLowerCase());
  const first = await one<{ id: string }>('SELECT id FROM users ORDER BY created_at, id LIMIT 1');
  return first?.id === user.id;
}

async function requirePlatformAdmin(req: FastifyRequest): Promise<AuthUser> {
  const user = requireUser(req);
  if (!(await isPlatformAdmin(user))) throw forbidden('platform administrators only');
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
