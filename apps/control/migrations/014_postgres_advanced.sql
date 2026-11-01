-- Advanced Postgres: point-in-time recovery (WAL archiving), read replicas, high availability,
-- PgBouncer connection pooling, major version upgrades and admin operations (repack).

ALTER TABLE databases DROP CONSTRAINT IF EXISTS databases_status_check;
ALTER TABLE databases ADD CONSTRAINT databases_status_check
  CHECK (status IN ('creating','available','suspended','failed','deleting','restoring','upgrading'));

ALTER TABLE databases
  ADD COLUMN high_availability boolean NOT NULL DEFAULT false,
  ADD COLUMN pitr_enabled_at   timestamptz,          -- WAL archiving active since (PITR window can't start before)
  ADD COLUMN pooler_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN pooler_port       integer,
  ADD COLUMN pooler_ref        text,                 -- pgbouncer pid (process) or container id (docker)
  ADD COLUMN recovered_from    jsonb;                -- {databaseId, targetTime} for point-in-time recoveries

-- Base backups remember where their WAL starts (archive pruning) and the server version (usable for PITR).
ALTER TABLE db_backups
  ADD COLUMN wal_start  text,
  ADD COLUMN pg_version integer;

-- Streaming replicas of a database: read replicas and the high-availability standby.
CREATE TABLE db_replicas (
  id          text PRIMARY KEY,
  database_id text NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'replica' CHECK (role IN ('replica','standby')),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','available','failed','deleting')),
  slot_name   text NOT NULL,
  node_id     text,
  host        text,
  port        integer,
  ref         text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX db_replicas_database ON db_replicas(database_id);
CREATE UNIQUE INDEX db_replicas_one_standby ON db_replicas(database_id) WHERE role = 'standby';

-- Long-running maintenance operations shown in the dashboard (upgrade, repack, recovery, failover).
CREATE TABLE db_operations (
  id          text PRIMARY KEY,
  database_id text NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('upgrade','repack','recover','failover')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  data        jsonb NOT NULL DEFAULT '{}',
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX db_operations_database ON db_operations(database_id, created_at DESC);

-- What a node can run: installed PostgreSQL versions and tools, PgBouncer.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}';
