// Advanced Postgres: point-in-time recovery, read replicas, connection pooling (PgBouncer), extensions,
// major version upgrades and admin insights (slow queries, table bloat, repack). Long-running work is done by the
// agent on the database's node (db_* jobs); quick inspections query the database directly.
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { decrypt } from '@nav/shared/crypto';
import { id } from '@nav/shared/ids';
import {
  PG_EXTENSION_ALLOW_LIST, PG_LATEST_VERSION, pitrRetentionDays, type DbExtension, type DbPooler, type DbRecoveryWindow, type DbSlowQuery,
  type DbTableStat, type DbUpgradeInfo,
} from '@nav/shared';
import { one, q, type Row } from '../../db/pool.ts';
import { badRequest, changed, conflict, enqueue, notFound, recordEvent } from '../../lib/core.ts';
import { PGBOUNCER_MISSING, slotName } from '../../lib/pgcommands.ts';
import * as ser from '../../lib/serialize.ts';
import { uniqueServiceSlug } from '../../lib/services.ts';
import { requireUser } from '../auth.ts';
import { dbFor } from './databases.ts';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Runs `fn` with a client connected to the database itself (statement timeout applies). */
async function withDb<T>(db: Row, fn: (c: pg.Client) => Promise<T>, opts: { database?: string; timeoutMs?: number } = {}): Promise<T> {
  if (db.status !== 'available') throw conflict(`database is ${db.status}`);
  const timeout = opts.timeoutMs ?? 15_000;
  const c = new pg.Client({
    host: db.host ?? '127.0.0.1', port: db.port, user: db.db_user, password: decrypt(db.password_enc), database: opts.database ?? db.db_name,
    connectionTimeoutMillis: 5000, statement_timeout: timeout, query_timeout: timeout + 2000,
  });
  c.on('error', () => {});
  try {
    await c.connect();
  } catch (err) {
    await c.end().catch(() => {});
    throw conflict(`could not connect to the database: ${(err as Error).message}`);
  }
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

interface NodeCaps { driver?: string; pgbouncer?: boolean; postgres?: { version: number; server: boolean; full: boolean; pgUpgrade: boolean; pgDump: boolean }[] }

async function nodeCaps(db: Row): Promise<NodeCaps | null> {
  if (!db.node_id) return null;
  const n = await one('SELECT capabilities FROM nodes WHERE id = $1', [db.node_id]);
  return (n?.capabilities as NodeCaps) ?? null;
}

/** Usable base backups: taken with WAL archiving on, by the current major version. */
const BASE_BACKUPS = `database_id = $1 AND status = 'completed' AND wal_start IS NOT NULL AND pg_version = $2 AND created_at >= $3`;

export async function recoveryWindow(db: Row): Promise<DbRecoveryWindow> {
  const retentionDays = pitrRetentionDays(db.plan);
  const off = (reason: string): DbRecoveryWindow => ({ enabled: false, retentionDays, earliest: null, latest: null, reason, lastArchivedAt: null });
  if (!retentionDays) return off('Point-in-time recovery is available on paid instance types.');
  if (db.driver === 'docker') return off('Point-in-time recovery is not supported on docker nodes yet.');
  if (!db.pitr_enabled_at) return off(db.status === 'available' ? 'WAL archiving is being enabled; the database restarts to apply it.' : `The database is ${db.status}.`);
  const first = await one(`SELECT min(finished_at) AS first FROM db_backups WHERE ${BASE_BACKUPS}`, [db.id, db.pg_version, db.pitr_enabled_at]);
  let lastArchivedAt: string | null = null;
  if (db.status === 'available') {
    lastArchivedAt = await withDb(db, async (c) => (await c.query('SELECT last_archived_time FROM pg_stat_archiver')).rows[0].last_archived_time, { timeoutMs: 3000 }).catch(() => null);
  }
  if (!first?.first) return { enabled: true, retentionDays, earliest: null, latest: null, reason: 'Waiting for the first base backup; recovery becomes possible when it completes.', lastArchivedAt };
  const floor = Date.now() - retentionDays * 86400e3;
  const earliest = new Date(Math.max(new Date(first.first).getTime(), floor)).toISOString();
  return { enabled: true, retentionDays, earliest, latest: new Date().toISOString(), reason: null, lastArchivedAt };
}

export async function upgradeInfo(db: Row): Promise<DbUpgradeInfo> {
  const current = db.pg_version;
  const info = (targets: DbUpgradeInfo['targets'], reason: string | null): DbUpgradeInfo => ({ currentVersion: current, targets, reason });
  if (current >= PG_LATEST_VERSION) return info([], `PostgreSQL ${current} is the newest supported version.`);
  if (db.driver === 'docker') {
    return info(Array.from({ length: PG_LATEST_VERSION - current }, (_, i) => ({ version: current + 1 + i, method: 'dump_restore' as const })), null);
  }
  const caps = await nodeCaps(db);
  const pgs = caps?.postgres ?? [];
  const old = pgs.find((p) => p.version === current && p.full);
  const targets: DbUpgradeInfo['targets'] = [];
  for (const p of pgs.filter((x) => x.version > current && x.server)) {
    if (old && p.pgUpgrade) targets.push({ version: p.version, method: 'pg_upgrade' });
    else if (pgs.some((x) => x.version >= p.version && x.pgDump)) targets.push({ version: p.version, method: 'dump_restore' });
  }
  return info(
    targets,
    targets.length ? null : `No newer PostgreSQL version is installed on this database's node. Install the PostgreSQL ${current + 1}+ server binaries (add their bin directory to NAV_PG_BIN_DIRS if not on PATH) and the agent will detect them within 5 minutes.`,
  );
}

async function poolerState(db: Row): Promise<DbPooler> {
  const caps = await nodeCaps(db);
  const available = db.driver === 'docker' || caps?.driver === 'docker' || caps?.pgbouncer === true;
  return {
    enabled: Boolean(db.pooler_enabled),
    available,
    mode: 'transaction',
    port: db.pooler_port ?? null,
    pooledExternalUrl: ser.database(db).pooledExternalUrl,
    reason: available ? null : db.node_id ? PGBOUNCER_MISSING : 'The database is not running on a node yet.',
  };
}

async function newOperation(db: Row, kind: string, data: Record<string, unknown>): Promise<Row> {
  return (await one('INSERT INTO db_operations (id, database_id, kind, data) VALUES ($1,$2,$3,$4) RETURNING *', [id('dbo'), db.id, kind, data]))!;
}

export async function databaseFeatureRoutes(app: FastifyInstance) {
  // Point-in-time recovery ----------------------------------------------------------
  app.get('/databases/:id/recovery', async (req) => recoveryWindow((await dbFor(req)).db));

  app.post('/databases/:id/recover', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    const body = z.object({ targetTime: z.string().datetime({ offset: true }), name: z.string().trim().min(1).max(64).optional() }).parse(req.body);
    const w = await recoveryWindow(db);
    if (!w.earliest || !w.latest) throw conflict(w.reason ?? 'point-in-time recovery is not available');
    const target = new Date(body.targetTime);
    if (target.getTime() < new Date(w.earliest).getTime() || target.getTime() > Date.now()) {
      throw badRequest(`targetTime must be between ${w.earliest} and now`);
    }
    const base = await one(`SELECT * FROM db_backups WHERE ${BASE_BACKUPS} AND finished_at <= $4 ORDER BY finished_at DESC LIMIT 1`, [db.id, db.pg_version, db.pitr_enabled_at, target.toISOString()]);
    if (!base) throw conflict('no base backup precedes that time');
    const name = body.name ?? `${db.name}-pitr-${target.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`.slice(0, 64);
    const newId = id('dpg');
    const row = (await one(
      `INSERT INTO databases (id, workspace_id, environment_id, name, slug, plan, pg_version, db_name, db_user, password_enc, disk_gb, ip_allow_list, status, driver, node_id, recovered_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'restoring',$13,$14,$15) RETURNING *`,
      [newId, db.workspace_id, db.environment_id, name, await uniqueServiceSlug(`${name}-db`), db.plan, db.pg_version, db.db_name, db.db_user, db.password_enc, db.disk_gb,
        JSON.stringify(db.ip_allow_list), db.driver, db.node_id, { databaseId: db.id, targetTime: target.toISOString() }],
    ))!;
    const op = await newOperation(row, 'recover', { sourceId: db.id, targetTime: target.toISOString(), backupId: base.id });
    // The new database is created on the source's node (that is where the base backups and WAL archive are).
    await enqueue('db_recover', { databaseId: newId, sourceId: db.id, backupId: base.id, targetTime: target.toISOString(), operationId: op.id }, { concurrencyKey: `db:${newId}` });
    const actorId = requireUser(req).id;
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId, kind: 'database_recovery_started', data: { targetTime: target.toISOString(), newDatabaseId: newId } });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: newId, actorId, kind: 'database_created', data: { name, recoveredFrom: db.id, targetTime: target.toISOString() } });
    return reply.status(202).send(ser.database(row));
  });

  // Read replicas ------------------------------------------------------------------
  app.get('/databases/:id/replicas', async (req) => {
    const { db } = await dbFor(req);
    const rows = await q('SELECT * FROM db_replicas WHERE database_id = $1 ORDER BY role DESC, created_at', [db.id]);
    const live = new Map<string, { state: string; lagBytes: number | null; lagSeconds: number | null }>();
    if (rows.length && db.status === 'available') {
      await withDb(db, async (c) => {
        const r = await c.query(
          `SELECT application_name, state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint AS lag_bytes,
                  EXTRACT(epoch FROM replay_lag)::float8 AS lag_s FROM pg_stat_replication`,
        );
        for (const x of r.rows) {
          const lagBytes = x.lag_bytes == null ? null : Number(x.lag_bytes);
          live.set(x.application_name, { state: x.state, lagBytes, lagSeconds: x.lag_s ?? (lagBytes === 0 ? 0 : null) });
        }
      }, { database: 'postgres', timeoutMs: 3000 }).catch(() => {});
    }
    return { items: rows.map((r) => ser.replica(r, db, live.get(r.id))), nextCursor: null };
  });

  app.post('/databases/:id/replicas', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    const body = z.object({ name: z.string().trim().min(1).max(64).regex(/^[\w .-]+$/, 'letters, digits, spaces, dots, dashes').optional() }).parse(req.body ?? {});
    if (db.status !== 'available') throw conflict(`database is ${db.status}`);
    if (db.plan === 'free') throw conflict('read replicas are available on paid instance types');
    const count = await one("SELECT count(*)::int AS n FROM db_replicas WHERE database_id = $1 AND role = 'replica'", [db.id]);
    if (count!.n >= 5) throw conflict('a database can have at most 5 read replicas');
    const rid = id('dbr');
    const row = (await one(
      "INSERT INTO db_replicas (id, database_id, role, name, slot_name) VALUES ($1,$2,'replica',$3,$4) RETURNING *",
      [rid, db.id, body.name ?? `${db.name}-replica-${count!.n + 1}`, slotName(rid)],
    ))!;
    await enqueue('db_replica_create', { databaseId: db.id, replicaId: rid }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_replica_requested', data: { replicaId: rid, name: row.name } });
    return reply.status(201).send(ser.replica(row, db));
  });

  app.delete('/databases/:id/replicas/:replicaId', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    const { replicaId } = req.params as { replicaId: string };
    const r = await one('SELECT * FROM db_replicas WHERE id = $1 AND database_id = $2', [replicaId, db.id]);
    if (!r) throw notFound('replica');
    if (r.role === 'standby') throw conflict('this is the high-availability standby; turn high availability off instead');
    await q("UPDATE db_replicas SET status = 'deleting', updated_at = now() WHERE id = $1", [r.id]);
    await enqueue('db_replica_delete', { databaseId: db.id, replicaId: r.id }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_replica_deleted', data: { replicaId: r.id, name: r.name } });
    await changed(db.workspace_id, 'database', db.id);
    return reply.status(204).send();
  });

  // Connection pooling ---------------------------------------------------------------
  app.get('/databases/:id/pooler', async (req) => poolerState((await dbFor(req)).db));

  app.post('/databases/:id/pooler', async (req) => {
    const { db } = await dbFor(req, 'developer');
    if (db.status !== 'available') throw conflict(`database is ${db.status}`);
    const state = await poolerState(db);
    if (!state.available) throw conflict(state.reason ?? PGBOUNCER_MISSING);
    if (!db.pooler_enabled) {
      await q('UPDATE databases SET pooler_enabled = true, updated_at = now() WHERE id = $1', [db.id]);
      await enqueue('db_pooler_start', { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
      await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_pooler_requested' });
    }
    return poolerState((await one('SELECT * FROM databases WHERE id = $1', [db.id]))!);
  });

  app.delete('/databases/:id/pooler', async (req) => {
    const { db } = await dbFor(req, 'developer');
    if (db.pooler_enabled) {
      await q('UPDATE databases SET pooler_enabled = false, updated_at = now() WHERE id = $1', [db.id]);
      await enqueue('db_pooler_stop', { databaseId: db.id }, { concurrencyKey: `db:${db.id}` });
      await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_pooler_disabled' });
    }
    return poolerState((await one('SELECT * FROM databases WHERE id = $1', [db.id]))!);
  });

  // Extensions ------------------------------------------------------------------------
  const listExtensions = (db: Row) => withDb(db, async (c): Promise<DbExtension[]> => {
    const preload = String((await c.query("SELECT current_setting('shared_preload_libraries') AS p")).rows[0].p);
    const r = await c.query('SELECT name, default_version, installed_version, comment FROM pg_available_extensions WHERE name = ANY($1) ORDER BY name', [[...PG_EXTENSION_ALLOW_LIST]]);
    return r.rows.map((x) => ({
      name: x.name, defaultVersion: x.default_version, installedVersion: x.installed_version, comment: x.comment,
      ready: x.name !== 'pg_stat_statements' || preload.split(',').map((s) => s.trim()).includes('pg_stat_statements'),
    }));
  });

  app.get('/databases/:id/extensions', async (req) => ({ items: await listExtensions((await dbFor(req)).db) }));

  app.post('/databases/:id/extensions', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    const { name } = z.object({ name: z.enum(PG_EXTENSION_ALLOW_LIST) }).parse(req.body);
    const ext = (await listExtensions(db)).find((e) => e.name === name);
    if (!ext) throw conflict(`the ${name} extension is not installed on this database server`);
    await withDb(db, async (c) => {
      try {
        await c.query(`CREATE EXTENSION IF NOT EXISTS ${ident(name)} CASCADE`);
      } catch (err) {
        throw conflict((err as Error).message);
      }
    });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_extension_created', data: { name } });
    return reply.status(201).send((await listExtensions(db)).find((e) => e.name === name));
  });

  app.delete('/databases/:id/extensions/:name', async (req, reply) => {
    const { db } = await dbFor(req, 'developer');
    const { name } = req.params as { name: string };
    if (!(PG_EXTENSION_ALLOW_LIST as readonly string[]).includes(name)) throw badRequest(`${name} is not a managed extension`);
    const cascade = (req.query as { cascade?: string }).cascade === 'true';
    await withDb(db, async (c) => {
      try {
        await c.query(`DROP EXTENSION IF EXISTS ${ident(name)}${cascade ? ' CASCADE' : ''}`);
      } catch (err) {
        throw conflict(`${(err as Error).message}${cascade ? '' : ' (retry with ?cascade=true to drop dependent objects too)'}`);
      }
    });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_extension_dropped', data: { name, cascade } });
    return reply.status(204).send();
  });

  // Major version upgrades -------------------------------------------------------------
  app.get('/databases/:id/upgrade', async (req) => upgradeInfo((await dbFor(req)).db));

  app.post('/databases/:id/upgrade', async (req, reply) => {
    const { db } = await dbFor(req, 'admin');
    const { version } = z.object({ version: z.number().int().min(14).max(PG_LATEST_VERSION) }).parse(req.body);
    if (db.status !== 'available') throw conflict(`database is ${db.status}`);
    if (version <= db.pg_version) throw badRequest(`the database already runs PostgreSQL ${db.pg_version}; only upgrades are supported`);
    const info = await upgradeInfo(db);
    const target = info.targets.find((t) => t.version === version);
    if (!target) throw conflict(info.reason ?? `PostgreSQL ${version} is not installed on this database's node`);
    const op = await newOperation(db, 'upgrade', { from: db.pg_version, to: version, method: target.method });
    await q("UPDATE databases SET status = 'upgrading', updated_at = now() WHERE id = $1", [db.id]);
    await enqueue('db_upgrade', { databaseId: db.id, version, operationId: op.id }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_upgrade_started', data: { from: db.pg_version, to: version, method: target.method } });
    await changed(db.workspace_id, 'database', db.id);
    return reply.status(202).send(ser.dbOperation(op));
  });

  // Insights ---------------------------------------------------------------------------
  app.get('/databases/:id/insights/slow-queries', async (req) => {
    const { db } = await dbFor(req, 'developer');
    const items = await withDb(db, async (c): Promise<DbSlowQuery[]> => {
      const preload = String((await c.query("SELECT current_setting('shared_preload_libraries') AS p")).rows[0].p);
      if (!preload.includes('pg_stat_statements')) throw conflict('pg_stat_statements is not loaded on this server yet. Restart the database to start collecting query statistics.');
      await c.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      const r = await c.query(
        `SELECT queryid::text AS id, query, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read
         FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND query NOT ILIKE '%pg_stat_statements%'
         ORDER BY total_exec_time DESC LIMIT 20`,
      );
      return r.rows.map((x) => {
        const hit = Number(x.shared_blks_hit);
        const read = Number(x.shared_blks_read);
        return {
          queryId: x.id, query: x.query, calls: Number(x.calls), totalMs: Number(Number(x.total_exec_time).toFixed(3)), meanMs: Number(Number(x.mean_exec_time).toFixed(3)),
          rows: Number(x.rows), cacheHitRatio: hit + read > 0 ? Number((hit / (hit + read)).toFixed(4)) : null,
        };
      });
    });
    return { items };
  });

  app.post('/databases/:id/insights/slow-queries/reset', async (req) => {
    const { db } = await dbFor(req, 'developer');
    await withDb(db, async (c) => {
      await c.query('SELECT pg_stat_statements_reset()').catch((err) => { throw conflict(err.message); });
    });
    return { ok: true };
  });

  app.get('/databases/:id/insights/tables', async (req) => {
    const { db } = await dbFor(req);
    const items = await withDb(db, async (c): Promise<DbTableStat[]> => {
      // Bloat estimate: actual heap size minus the pages the live rows need (avg row width from pg_stats + header).
      const r = await c.query(
        `WITH t AS (
           SELECT c.oid, n.nspname AS schema, c.relname AS tbl, c.reltuples, current_setting('block_size')::int AS bs,
                  (SELECT sum(s.avg_width) FROM pg_stats s WHERE s.schemaname = n.nspname AND s.tablename = c.relname) AS width,
                  COALESCE((SELECT substring(o from 'fillfactor=(\\d+)')::int FROM unnest(c.reloptions) o WHERE o LIKE 'fillfactor=%'), 100) AS ff
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%')
         SELECT t.schema, t.tbl, pg_total_relation_size(t.oid) AS total, pg_relation_size(t.oid) AS heap, pg_indexes_size(t.oid) AS idx,
                COALESCE(s.n_live_tup, 0) AS live, COALESCE(s.n_dead_tup, 0) AS dead, s.last_vacuum, s.last_autovacuum,
                CASE WHEN t.reltuples < 0 OR t.width IS NULL THEN NULL
                     ELSE GREATEST(0, pg_relation_size(t.oid) - ceil(t.reltuples * (t.width + 28) / (t.bs * t.ff / 100.0 - 24)) * t.bs) END AS bloat
         FROM t LEFT JOIN pg_stat_user_tables s ON s.relid = t.oid
         ORDER BY total DESC LIMIT 100`,
      );
      return r.rows.map((x) => ({
        schema: x.schema, table: x.tbl, totalBytes: Number(x.total), tableBytes: Number(x.heap), indexBytes: Number(x.idx),
        liveTuples: Number(x.live), deadTuples: Number(x.dead), bloatBytes: x.bloat == null ? null : Number(x.bloat),
        lastVacuum: x.last_vacuum, lastAutovacuum: x.last_autovacuum,
      }));
    });
    return { items };
  });

  app.post('/databases/:id/repack', async (req, reply) => {
    const { db } = await dbFor(req, 'admin');
    const body = z.object({ schema: z.string().min(1).max(63).default('public'), table: z.string().min(1).max(63) }).parse(req.body);
    const exists = await withDb(db, async (c) => (await c.query(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','m')", [body.schema, body.table],
    )).rowCount);
    if (!exists) throw notFound(`table ${body.schema}.${body.table}`);
    const running = await one("SELECT 1 FROM db_operations WHERE database_id = $1 AND kind IN ('repack','upgrade') AND status IN ('pending','running')", [db.id]);
    if (running) throw conflict('another maintenance operation is in progress');
    const op = await newOperation(db, 'repack', { schema: body.schema, table: body.table });
    await enqueue('db_repack', { databaseId: db.id, operationId: op.id, schema: body.schema, table: body.table }, { concurrencyKey: `db:${db.id}` });
    await recordEvent({ workspaceId: db.workspace_id, databaseId: db.id, actorId: requireUser(req).id, kind: 'database_repack_started', data: { table: `${body.schema}.${body.table}` } });
    return reply.status(202).send(ser.dbOperation(op));
  });

  app.get('/databases/:id/operations', async (req) => {
    const { db } = await dbFor(req);
    const rows = await q('SELECT * FROM db_operations WHERE database_id = $1 ORDER BY created_at DESC LIMIT 25', [db.id]);
    return { items: rows.map(ser.dbOperation), nextCursor: null };
  });
}
