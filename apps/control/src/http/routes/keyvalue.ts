// Key Value (Redis-compatible) instances: create, inspect, change plan / eviction policy / allow list, suspend, delete.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '@nav/shared/config';
import { decrypt, encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { KEY_VALUE_PLANS, KEY_VALUE_POLICIES, slugify, type Role } from '@nav/shared';
import { one, q, type Row } from '../../db/pool.ts';
import { badRequest, enqueue, notFound, recordEvent } from '../../lib/core.ts';
import { requireUser, workspaceRole } from '../auth.ts';
import { uniqueSlug } from './auth.ts';

const Cidr = z.object({ cidr: z.string().regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/, 'expected a CIDR like 203.0.113.0/24'), description: z.string().max(100).default('') });

export function keyValueOut(r: Row) {
  const pw = '********';
  const internalHost = r.driver === 'docker' ? r.slug : r.host;
  const internalPort = r.driver === 'docker' ? 6379 : r.port;
  const ok = r.status === 'available';
  // External access is TLS only, through the agent's proxy. With the platform wildcard certificate clients verify
  // <slug>.<appsDomain>; with the node's self-signed one they connect by IP and must pin or skip verification.
  const tls = ok && (r.ip_allow_list ?? []).length && r.tls_port && r.tls_cert ? { certificate: r.tls_cert as 'platform' | 'self-signed', fingerprint: r.tls_fingerprint ?? null } : null;
  const externalHost = tls?.certificate === 'platform' ? `${r.slug}.${config.appsDomain}` : config.edgePublicIp;
  return {
    id: r.id, workspaceId: r.workspace_id, environmentId: r.environment_id, name: r.name, slug: r.slug, plan: r.plan,
    maxmemoryPolicy: r.maxmemory_policy, status: r.status, ipAllowList: r.ip_allow_list,
    internalUrl: ok ? `redis://default:${pw}@${internalHost}:${internalPort}` : null,
    externalUrl: tls ? `rediss://default:${pw}@${externalHost}:${r.tls_port}` : null,
    externalTls: tls,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function kvFor(req: FastifyRequest, min: Role = 'viewer'): Promise<Row> {
  const row = await one('SELECT * FROM key_values WHERE id = $1', [(req.params as { id: string }).id]);
  if (!row) throw notFound('key value');
  await workspaceRole(req, row.workspace_id, min).catch((err) => { throw err.status === 403 ? err : notFound('key value'); });
  return row;
}

const job = (kind: string, kv: Row) => enqueue(kind, { keyValueId: kv.id }, { concurrencyKey: `kv:${kv.id}` });

export async function keyValueRoutes(app: FastifyInstance) {
  app.get('/key-value-plans', async () => ({ plans: KEY_VALUE_PLANS, policies: KEY_VALUE_POLICIES }));

  app.get('/workspaces/:ws/key-value', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    return { items: (await q('SELECT * FROM key_values WHERE workspace_id = $1 ORDER BY created_at DESC', [ws])).map(keyValueOut) };
  });

  app.post('/workspaces/:ws/key-value', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const body = z.object({
      name: z.string().trim().min(1).max(64),
      plan: z.string().default('free'),
      maxmemoryPolicy: z.enum(KEY_VALUE_POLICIES).default('allkeys-lru'),
      ipAllowList: z.array(Cidr).max(50).default([]),
      environmentId: z.string().nullable().optional(),
    }).parse(req.body);
    if (!KEY_VALUE_PLANS.some((p) => p.id === body.plan)) throw badRequest('unknown plan');
    const slug = await uniqueSlug(null, 'key_values', `${slugify(body.name)}-kv`);
    const row = await one(
      `INSERT INTO key_values (id, workspace_id, environment_id, name, slug, plan, maxmemory_policy, password_enc, ip_allow_list)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id('kv'), ws, body.environmentId ?? null, body.name, slug, body.plan, body.maxmemoryPolicy, encrypt(randomBytes(24).toString('base64url')), JSON.stringify(body.ipAllowList)],
    );
    await job('kv_provision', row!);
    await recordEvent({ workspaceId: ws, actorId: requireUser(req).id, kind: 'key_value_created', data: { keyValueId: row!.id, name: body.name } });
    return reply.status(201).send(keyValueOut(row!));
  });

  app.get('/key-value/:id', async (req) => keyValueOut(await kvFor(req)));

  /** Full connection strings (with the password) for developers and above. */
  app.get('/key-value/:id/credentials', async (req) => {
    const kv = await kvFor(req, 'developer');
    const out = keyValueOut(kv);
    const pw = decrypt(kv.password_enc);
    return { password: pw, internalUrl: out.internalUrl?.replace('********', pw) ?? null, externalUrl: out.externalUrl?.replace('********', pw) ?? null };
  });

  app.patch('/key-value/:id', async (req) => {
    const kv = await kvFor(req, 'developer');
    const body = z.object({
      name: z.string().trim().min(1).max(64).optional(),
      plan: z.string().optional(),
      maxmemoryPolicy: z.enum(KEY_VALUE_POLICIES).optional(),
      ipAllowList: z.array(Cidr).max(50).optional(),
    }).parse(req.body);
    if (body.plan && !KEY_VALUE_PLANS.some((p) => p.id === body.plan)) throw badRequest('unknown plan');
    const row = await one(
      `UPDATE key_values SET name = COALESCE($2, name), plan = COALESCE($3, plan), maxmemory_policy = COALESCE($4, maxmemory_policy),
         ip_allow_list = COALESCE($5, ip_allow_list), updated_at = now() WHERE id = $1 RETURNING *`,
      [kv.id, body.name ?? null, body.plan ?? null, body.maxmemoryPolicy ?? null, body.ipAllowList ? JSON.stringify(body.ipAllowList) : null],
    );
    if (body.plan || body.maxmemoryPolicy || body.ipAllowList) await job('kv_reconfigure', row!);
    return keyValueOut(row!);
  });

  app.post('/key-value/:id/suspend', async (req) => {
    const kv = await kvFor(req, 'developer');
    await job('kv_suspend', kv);
    return keyValueOut(kv);
  });

  app.post('/key-value/:id/resume', async (req) => {
    const kv = await kvFor(req, 'developer');
    await job('kv_resume', kv);
    return keyValueOut(kv);
  });

  app.delete('/key-value/:id', async (req, reply) => {
    const kv = await kvFor(req, 'admin');
    await q("UPDATE key_values SET status = 'deleting' WHERE id = $1", [kv.id]);
    await job('kv_delete', kv);
    return reply.status(204).send();
  });

  app.get('/key-value/:id/logs', async (req) => {
    const kv = await kvFor(req);
    const rows = await q('SELECT id, ts, level, message FROM logs WHERE database_id = $1 ORDER BY id DESC LIMIT 500', [kv.id]);
    return { items: rows.reverse().map((r) => ({ id: Number(r.id), ts: r.ts, level: r.level, message: r.message })) };
  });
}
