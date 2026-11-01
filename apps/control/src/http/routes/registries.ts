// Credentials for private container registries, used when image-backed services pull. Passwords (or tokens)
// are encrypted at rest and never returned.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { one, q, type Row } from '../../db/pool.ts';
import { notFound } from '../../lib/core.ts';
import { workspaceRole } from '../auth.ts';

const out = (r: Row) => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, registry: r.registry, username: r.username, createdAt: r.created_at });

const Body = z.object({
  name: z.string().trim().min(1).max(64),
  registry: z.string().trim().min(3).max(255).regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]*)?$/i, 'expected a registry host like ghcr.io'),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(4096),
});

async function credFor(req: FastifyRequest): Promise<Row> {
  const row = await one('SELECT * FROM registry_credentials WHERE id = $1', [(req.params as { id: string }).id]);
  if (!row) throw notFound('registry credential');
  await workspaceRole(req, row.workspace_id, 'admin').catch(() => { throw notFound('registry credential'); });
  return row;
}

export async function registryRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/registry-credentials', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    return { items: (await q('SELECT * FROM registry_credentials WHERE workspace_id = $1 ORDER BY name', [ws])).map(out) };
  });

  app.post('/workspaces/:ws/registry-credentials', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const b = Body.parse(req.body);
    const row = await one('INSERT INTO registry_credentials (id, workspace_id, name, registry, username, password_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [id('reg'), ws, b.name, b.registry.toLowerCase(), b.username, encrypt(b.password)]);
    return reply.status(201).send(out(row!));
  });

  app.patch('/registry-credentials/:id', async (req) => {
    const cred = await credFor(req);
    const b = Body.partial().parse(req.body);
    const row = await one(
      'UPDATE registry_credentials SET name = COALESCE($2, name), registry = COALESCE($3, registry), username = COALESCE($4, username), password_enc = COALESCE($5, password_enc) WHERE id = $1 RETURNING *',
      [cred.id, b.name ?? null, b.registry?.toLowerCase() ?? null, b.username ?? null, b.password ? encrypt(b.password) : null],
    );
    return out(row!);
  });

  app.delete('/registry-credentials/:id', async (req, reply) => {
    const cred = await credFor(req);
    await q('UPDATE services SET registry_credential_id = NULL WHERE registry_credential_id = $1', [cred.id]);
    await q('DELETE FROM registry_credentials WHERE id = $1', [cred.id]);
    return reply.status(204).send();
  });
}
