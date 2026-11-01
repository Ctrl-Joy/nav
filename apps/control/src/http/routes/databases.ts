import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { config } from '@nav/shared/config';
import { decrypt, encrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import { DATABASE_PLANS, haAvailable, slugify, type DatabaseCredentials } from '@nav/shared';
import { one, q, type Row } from '../../db/pool.ts';
import { badRequest, changed, conflict, enqueue, notFound, recordEvent } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { uniqueServiceSlug } from '../../lib/services.ts';
import { requireUser, scoped, workspaceRole } from '../auth.ts';
import { onLog, openSse } from '../sse.ts';

const Ident = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a lowercase identifier');
const Cidr = z.object({
  cidr: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/, 'must be an IPv4 CIDR like 203.0.113.0/24'),
  description: z.string().max(200).default(''),
});

export async function dbFor(req: FastifyRequest, min: 'viewer' | 'developer' | 'admin' = 'viewer') {
  const { row, role } = await scoped(req, 'databases', (req.params as { id: string }).id, min);
  if (row.status === 'deleting') throw notFound('database');
  return { db: row, role };
}

export function credentials(db: Row): DatabaseCredentials {
  const password = decrypt(db.password_enc);
  const host = db.host ?? '127.0.0.1';
  const port = db.port ?? 5432;
  const enc = encodeURIComponent;
  return {
    host,
    port,
    database: db.db_name,
    user: db.db_user,
    password,
    internalUrl: db.driver === 'docker'
      ? `postgresql://${enc(db.db_user)}:${enc(password)}@${db.slug}:5432/${db.db_name}`
      : `postgresql://${enc(db.db_user)}:${enc(password)}@${host}:${port}/${db.db_name}`,
    externalUrl: `postgresql://${enc(db.db_user)}:${enc(password)}@${config.edgePublicIp}:${port}/${db.db_name}`,
    psqlCommand: `PGPASSWORD=${password} psql -h ${config.edgePublicIp} -p ${port} -U ${db.db_user} ${db.db_name}`,
    pooledInternalUrl: db.pooler_enabled && db.pooler_port
      ? db.driver === 'docker'
        ? `postgresql://${enc(db.db_user)}:${enc(password)}@${db.slug}-pooler:6432/${db.db_name}`
        : `postgresql://${enc(db.db_user)}:${enc(password)}@${host}:${db.pooler_port}/${db.db_name}`
      : null,
    pooledExternalUrl: db.pooler_enabled && db.pooler_port ? `postgresql://${enc(db.db_user)}:${enc(password)}@${config.edgePublicIp}:${db.pooler_port}/${db.db_name}` : null,
  };
}

export async function createDatabase(workspaceId: string, actorId: string | null, input: { name: string; plan?: string; pgVersion?: number; databaseName?: string; user?: string; environmentId?: string | null; diskGB?: number }): Promise<Row> {
  const plan = input.plan ?? 'basic-256mb';
  if (!DATABASE_PLANS.some((p) => p.id === plan)) throw badRequest(`unknown database plan "${plan}"`);
  const base = slugify(input.name).replace(/-/g, '_').replace(/^(\d)/, '_$1');
  const dbId = id('dpg');
  const row = await one(
    `INSERT INTO databases (id, workspace_id, environment_id, name, slug, plan, pg_version, db_name, db_user, password_enc, disk_gb)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [dbId, workspaceId, input.environmentId ?? null, input.name, await uniqueServiceSlug(`${input.name}-db`), plan, input.pgVersion ?? 17,
      input.databaseName ?? base.slice(0, 40), input.user ?? `${base.slice(0, 20)}_user`, encrypt(randomBytes(24).toString('base64url')), input.diskGB ?? 1],
  );
  await enqueue('db_provision', { databaseId: dbId }, { concurrencyKey: `db:${dbId}` });
  await recordEvent({ workspaceId, databaseId: dbId, actorId, kind: 'database_created', data: { name: input.name } });
  return row!;
}

export async function databaseRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/databases', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws);
    const rows = await q("SELECT * FROM databases WHERE workspace_id = $1 AND status <> 'deleting' ORDER BY created_at DESC", [ws]);
    return { items: rows.map(ser.database), nextCursor: null };
  });

  app.post('/workspaces/:ws/databases', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const body = z.object({
      name: z.string().trim().min(1).max(64),
      plan: z.string().optional(),
      pgVersion: z.number().int().min(14).max(18).optional(),
      databaseName: Ident.optional(),
      user: Ident.optional(),
      environmentId: z.string().nullable().optional(),
      diskGB: z.number().int().min(1).max(4096).optional(),
    }).parse(req.body);
    if (body.user && ['postgres', 'nav'].includes(body.user)) throw badRequest('that user name is reserved');
    const row = await createDatabase(ws, requireUser(req).id, body);
    return reply.status(201).send(ser.database(row));
  });

  app.get('/databases/:id', async (req) => ser.database((await dbFor(req)).db));

  app.patch('/databases/:id', async (req) => {
    const { db } = await dbFor(req, 'developer');
    const body = z.object({
      name: z.string().trim().min(1).max(64).optional(),
      plan: z.string().optional(),
      ipAllowList: z.array(Cidr).max(50).optional(),
      diskGB: z.number().int().min(1).max(4096).optional(),
      highAvailability: z.boolean().optional(),
    }).parse(req.body);
    if (body.plan && !DATABASE_PLANS.some((p) => p.id === body.plan)) throw badRequest('unknown plan');
    if (body.diskGB && body.diskGB < db.disk_gb) throw badRequest('disk size can only be increased');
    const ha = body.highAvailability ?? db.high_availability;
    if (ha && !haAvailable(body.plan ?? db.plan)) {
      throw conflict(body.highAvailability ? 'high availability is available on paid plans; upgrade the instance type first' : 'disable high availability before moving to the free plan');
    }
    const haChanged = body.highAvailability !== undefined && body.highAvailability !== db.high_availability;
    if (haChanged && db.status !== 'available') throw conflict(`database is ${db.status}`);
    const row = await one(
      `UPDATE databases SET name = COALESCE($2, name), plan = COALESCE($3, plan), ip_allow_list = COALESCE($4, ip_allow_list),
       disk_gb = COALESCE($5, disk_gb), high_availability = COALESCE($6, high_availability), updated_at = now() WHERE id = $1 RETURNING *`,
      [db.id, body.name ?? null, body.plan ?? null, body.ipAllowList ? JSON.stringify(body.ipAllowList) : null, body.diskGB ?? null, body.highAvailability ?? null],
    );
    if (body.ipAllowList || body.plan) await enqueue('db_reconfigure', { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
    if (haChanged) await enqueue(body.highAvailability ? 'db_ha_enable' : 'db_ha_disable', { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_updated', data: { fields: Object.keys(body) } });
    return ser.database(row!);
  });

  app.delete('/databases/:id', async (req, reply) => {
    const { db } = await dbFor(req, 'admin');
    await q("UPDATE databases SET status = 'deleting' WHERE id = $1", [db.id]);
    await enqueue('db_delete', { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_deleted', data: { name: db.name } });
    return reply.status(204).send();
  });

  app.get('/databases/:id/credentials', async (req) => {
    const { db } = await dbFor(req, 'developer');
    if (db.status !== 'available' && db.status !== 'suspended') throw conflict(`database is ${db.status}`);
    const creds = credentials(db);
    const enc = encodeURIComponent;
    const replicas = await q("SELECT * FROM db_replicas WHERE database_id = $1 AND role = 'replica' AND status = 'available' ORDER BY created_at", [db.id]);
    creds.replicas = replicas.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      internalUrl: db.driver === 'docker'
        ? `postgresql://${enc(db.db_user)}:${enc(creds.password)}@${db.slug}-${r.id}:5432/${db.db_name}`
        : `postgresql://${enc(db.db_user)}:${enc(creds.password)}@${r.host}:${r.port}/${db.db_name}`,
      externalUrl: `postgresql://${enc(db.db_user)}:${enc(creds.password)}@${config.edgePublicIp}:${r.port}/${db.db_name}`,
    }));
    return creds;
  });

  for (const action of ['suspend', 'resume', 'restart'] as const) {
    app.post(`/databases/:id/${action}`, async (req) => {
      const { db } = await dbFor(req, 'developer');
      if (action === 'suspend' && db.status !== 'available') throw conflict(`database is ${db.status}`);
      if (action === 'resume' && db.status !== 'suspended') throw conflict('database is not suspended');
      await enqueue(`db_${action}`, { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
      await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: `database_${action}` });
      return { ok: true };
    });
  }

  // Backups ---------------------------------------------------------------------
  app.get('/databases/:id/backups', async (req) => {
    const { db } = await dbFor(req);
    const rows = await q('SELECT * FROM db_backups WHERE database_id = $1 ORDER BY created_at DESC LIMIT 100', [db.id]);
    return { items: rows.map(ser.backup), nextCursor: null };
  });

  app.post('/databases/:id/backups', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    if (db.status !== 'available') throw conflict(`database is ${db.status}`);
    const row = await one("INSERT INTO db_backups (id, database_id, kind) VALUES ($1,$2,'manual') RETURNING *", [id('bkp'), db.id]);
    await enqueue('db_backup', { databaseId: db.id, backupId: row!.id }, { concurrencyKey: `db:${db.id}` });
    return reply.status(201).send(ser.backup(row!));
  });

  app.post('/databases/:id/backups/:backupId/restore', async (req) => {
    const { db } = await dbFor(req, 'admin');
    const { backupId } = req.params as { backupId: string };
    const b = await one("SELECT * FROM db_backups WHERE id = $1 AND database_id = $2 AND status = 'completed'", [backupId, db.id]);
    if (!b) throw notFound('backup');
    await q("UPDATE databases SET status = 'restoring' WHERE id = $1", [db.id]);
    await enqueue('db_restore', { databaseId: db.id, backupId }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_restore_started', data: { backupId } });
    await changed(db.workspace_id, 'database', db.id);
    return { ok: true };
  });

  app.get('/databases/:id/backups/:backupId/download', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    const { backupId } = req.params as { backupId: string };
    const b = await one("SELECT * FROM db_backups WHERE id = $1 AND database_id = $2 AND status = 'completed'", [backupId, db.id]);
    if (!b?.path || !existsSync(b.path)) throw notFound('backup file');
    const ext = b.path.endsWith('.sql.gz') ? 'sql.gz' : 'tar.gz';
    reply.header('content-disposition', `attachment; filename="${db.slug}-${b.created_at.slice(0, 10)}-${b.id}.${ext}"`);
    return reply.type('application/gzip').send(createReadStream(b.path));
  });

  // Logs & metrics ---------------------------------------------------------------
  app.get('/databases/:id/logs', async (req) => {
    const { db } = await dbFor(req);
    const { before, limit } = req.query as { before?: string; limit?: string };
    const rows = await q(`SELECT * FROM logs WHERE database_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [db.id, before ? Number(before) : null, Math.min(Number(limit) || 200, 2000)]);
    return { items: rows.reverse().map(ser.logLine) };
  });

  app.get('/databases/:id/logs/stream', async (req, reply) => {
    const { db } = await dbFor(req);
    const stream = openSse(req, reply);
    let lastId = Number((await one('SELECT COALESCE(max(id),0) AS id FROM logs WHERE database_id = $1', [db.id]))?.id ?? 0);
    const pump = async () => {
      const rows = await q('SELECT * FROM logs WHERE database_id = $1 AND id > $2 ORDER BY id LIMIT 1000', [db.id, lastId]);
      for (const r of rows) { stream.send('log', ser.logLine(r), r.id); lastId = r.id; }
    };
    stream.onClose(onLog((n) => { if (n.databaseId === db.id) void pump(); }));
  });

  app.get('/databases/:id/metrics', async (req) => {
    const { db } = await dbFor(req);
    const range = (req.query as { range?: string }).range ?? '1h';
    const spans: Record<string, [number, string]> = { '1h': [3600e3, '1 minute'], '6h': [6 * 3600e3, '5 minutes'], '24h': [86400e3, '15 minutes'], '7d': [7 * 86400e3, '2 hours'] };
    const [ms, bucket] = spans[range] ?? spans['1h'];
    const rows = await q(
      `SELECT date_bin($3::interval, ts, TIMESTAMPTZ '2000-01-01') AS b, avg(cpu) AS cpu, avg(mem_bytes) AS mem
       FROM metrics WHERE service_id = $1 AND ts >= $2 GROUP BY 1 ORDER BY 1`,
      [db.id, new Date(Date.now() - ms), bucket],
    );
    let connections = 0;
    let sizeBytes = 0;
    if (db.status === 'available') {
      const c = new pg.Client({ connectionString: credentials(db).internalUrl.replace(`@${db.slug}:5432`, `@${db.host}:${db.port}`), connectionTimeoutMillis: 3000 });
      try {
        await c.connect();
        const r = await c.query('SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns, pg_database_size(current_database())::bigint AS size');
        connections = r.rows[0].conns;
        sizeBytes = Number(r.rows[0].size);
      } catch { /* database unreachable: report zeros */ } finally { c.end().catch(() => {}); }
    }
    const plan = DATABASE_PLANS.find((p) => p.id === db.plan);
    return {
      cpu: rows.map((r) => [r.b, Number(Number(r.cpu).toFixed(4))]),
      memoryMB: rows.map((r) => [r.b, Math.round(Number(r.mem) / 1048576)]),
      memoryLimitMB: plan?.memoryMB ?? 256,
      connections: [[new Date().toISOString(), connections]],
      sizeBytes: [[new Date().toISOString(), sizeBytes]],
      diskLimitBytes: db.disk_gb * 1024 ** 3,
    };
  });

  // SQL console ----------------------------------------------------------------------
  app.post('/databases/:id/query', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { db } = await dbFor(req, 'developer');
    if (db.status !== 'available') throw conflict(`database is ${db.status}`);
    const { sql } = z.object({ sql: z.string().min(1).max(100_000) }).parse(req.body);
    const creds = credentials(db);
    const client = new pg.Client({ host: db.host, port: db.port, user: creds.user, password: creds.password, database: creds.database, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7000 });
    const started = performance.now();
    try {
      await client.connect();
      const res = await client.query({ text: sql, rowMode: 'array' });
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      const rows = (last.rows ?? []).slice(0, 1000).map((r: unknown[]) => r.map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null && !Buffer.isBuffer(v) ? JSON.stringify(v) : Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : v)));
      return {
        columns: (last.fields ?? []).map((f: { name: string }) => f.name),
        rows,
        rowCount: last.rowCount ?? rows.length,
        truncated: (last.rows?.length ?? 0) > 1000,
        command: last.command,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      throw badRequest((err as Error).message);
    } finally {
      client.end().catch(() => {});
    }
  });
}
