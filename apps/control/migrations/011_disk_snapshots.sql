-- Snapshots of a service's persistent disk: daily automatic (7 kept) and on demand; restorable.
CREATE TABLE disk_snapshots (
  id          text PRIMARY KEY,
  service_id  text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'manual' CHECK (kind IN ('automatic','manual')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','restoring')),
  store       jsonb,                                  -- {key, digest, size} in the artifact store
  size_bytes  bigint,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX disk_snapshots_service ON disk_snapshots(service_id, created_at DESC);
