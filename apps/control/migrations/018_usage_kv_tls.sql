-- Usage: a durable ledger of billable time, kept by triggers so it survives the 1-day instance and 8-day
-- http_metrics retention and the deletion of services, databases and Key Value instances.
--
-- usage_periods: one row per span of something running. kind:
--   instance  - a service instance (ref_id = instance id), plan = the service's plan when it was placed
--   disk      - a service's persistent disk (quantity = GB) while it exists
--   database  - a Postgres database while available/restoring (quantity = storage GB)
--   key_value - a Key Value instance while available
--   build     - one deploy's build (ref_id = deploy id), started_at -> build end
-- ended_at NULL means still running; readers clip every span to the window they report on.
CREATE TABLE usage_periods (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('instance','disk','database','key_value','build')),
  resource_id  text NOT NULL,                  -- service / database / key value id
  ref_id       text NOT NULL,                  -- instance id, deploy id, or the resource id itself
  plan         text,
  quantity     double precision NOT NULL DEFAULT 1,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz
);
-- Month reports: everything in a workspace that ended after the window opened (old history is skipped).
CREATE INDEX usage_periods_ws_end ON usage_periods(workspace_id, (COALESCE(ended_at, 'infinity'::timestamptz)));
CREATE INDEX usage_periods_open ON usage_periods(kind, ref_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX usage_periods_once ON usage_periods(kind, ref_id) WHERE kind IN ('instance','build');

-- Names and types of every service / database / key value ever created, so reports can still label deleted ones.
CREATE TABLE usage_resources (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('service','database','key_value')),
  name         text NOT NULL,
  type         text,                           -- service type
  deleted_at   timestamptz
);
CREATE INDEX usage_resources_ws ON usage_resources(workspace_id);

-- Bytes sent by the edge per service and UTC day (http_metrics itself is kept for 8 days only).
CREATE TABLE usage_bandwidth_daily (
  service_id   text NOT NULL,
  workspace_id text NOT NULL,
  day          date NOT NULL,
  bytes_out    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, day)
);
CREATE INDEX usage_bandwidth_ws_day ON usage_bandwidth_daily(workspace_id, day);

-- Services, databases, key values: registry row + plan / disk periods.
CREATE FUNCTION usage_track_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r      record;
  rkind  text;
  was_on boolean := false;
  is_on  boolean := false;
  qty_old double precision;
  qty_new double precision;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  rkind := CASE TG_TABLE_NAME WHEN 'services' THEN 'service' WHEN 'databases' THEN 'database' ELSE 'key_value' END;

  IF TG_OP = 'DELETE' THEN
    UPDATE usage_resources SET deleted_at = now() WHERE id = OLD.id;
  ELSIF TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO usage_resources (id, workspace_id, kind, name, type)
    VALUES (NEW.id, NEW.workspace_id, rkind, NEW.name, CASE WHEN rkind = 'service' THEN to_jsonb(NEW)->>'type' END)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL;
  END IF;

  IF rkind = 'service' THEN
    -- Persistent disk: a period per (existence, size).
    IF TG_OP <> 'INSERT' AND OLD.disk IS NOT NULL THEN was_on := true; qty_old := (OLD.disk->>'sizeGB')::double precision; END IF;
    IF TG_OP <> 'DELETE' AND NEW.disk IS NOT NULL THEN is_on := true; qty_new := (NEW.disk->>'sizeGB')::double precision; END IF;
    IF TG_OP = 'UPDATE' AND was_on = is_on AND qty_old IS NOT DISTINCT FROM qty_new THEN RETURN NULL; END IF;
    UPDATE usage_periods SET ended_at = now() WHERE kind = 'disk' AND ref_id = r.id AND ended_at IS NULL;
    IF is_on THEN
      INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, quantity, started_at)
      VALUES (NEW.workspace_id, 'disk', NEW.id, NEW.id, COALESCE(qty_new, 0), now());
    END IF;
    RETURN NULL;
  END IF;

  -- Databases and key values: billed while running, a period per (plan, storage size).
  IF TG_OP <> 'INSERT' THEN
    was_on := OLD.status IN ('available','restoring');
    qty_old := COALESCE((to_jsonb(OLD)->>'disk_gb')::double precision, 1);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    is_on := NEW.status IN ('available','restoring');
    qty_new := COALESCE((to_jsonb(NEW)->>'disk_gb')::double precision, 1);
  END IF;
  IF TG_OP = 'UPDATE' AND was_on = is_on AND (NOT is_on OR (NEW.plan = OLD.plan AND qty_old = qty_new)) THEN RETURN NULL; END IF;
  UPDATE usage_periods SET ended_at = now() WHERE kind = rkind AND ref_id = r.id AND ended_at IS NULL;
  IF is_on THEN
    INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, plan, quantity, started_at)
    VALUES (NEW.workspace_id, rkind, NEW.id, NEW.id, NEW.plan, qty_new, now());
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER usage_services AFTER INSERT OR DELETE OR UPDATE OF name, disk ON services
  FOR EACH ROW EXECUTE FUNCTION usage_track_resource();
CREATE TRIGGER usage_databases AFTER INSERT OR DELETE OR UPDATE OF name, plan, status, disk_gb ON databases
  FOR EACH ROW EXECUTE FUNCTION usage_track_resource();
CREATE TRIGGER usage_key_values AFTER INSERT OR DELETE OR UPDATE OF name, plan, status ON key_values
  FOR EACH ROW EXECUTE FUNCTION usage_track_resource();

-- Instances: one period from (re)start to stop. Pending time before the agent starts it is not counted
-- (the agent moves started_at forward when it does). Deleting a running instance (service deleted) closes it.
CREATE FUNCTION usage_track_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, plan, started_at, ended_at)
    SELECT s.workspace_id, 'instance', s.id, NEW.id, s.plan, NEW.started_at, NEW.stopped_at FROM services s WHERE s.id = NEW.service_id
    ON CONFLICT DO NOTHING;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE usage_periods SET started_at = NEW.started_at, ended_at = NEW.stopped_at WHERE kind = 'instance' AND ref_id = NEW.id;
  ELSE
    UPDATE usage_periods SET ended_at = now() WHERE kind = 'instance' AND ref_id = OLD.id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER usage_instances AFTER INSERT OR DELETE OR UPDATE OF started_at, stopped_at ON instances
  FOR EACH ROW EXECUTE FUNCTION usage_track_instance();

-- Builds: recorded once, when the build ends (successfully, or failed / canceled during the build).
CREATE FUNCTION usage_build_end(d deploys) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(d.build_finished_at, CASE WHEN d.status IN ('build_failed','canceled') THEN d.finished_at END)
$$;

CREATE FUNCTION usage_track_build() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.started_at IS NULL OR usage_build_end(NEW) IS NULL THEN RETURN NULL; END IF;
  INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, started_at, ended_at)
  SELECT s.workspace_id, 'build', s.id, NEW.id, NEW.started_at, GREATEST(NEW.started_at, usage_build_end(NEW)) FROM services s WHERE s.id = NEW.service_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER usage_deploys AFTER INSERT OR UPDATE OF build_finished_at, finished_at ON deploys
  FOR EACH ROW EXECUTE FUNCTION usage_track_build();

-- Bandwidth: the edge upserts per-minute counters (bytes_out = bytes_out + delta); add each delta to the day.
CREATE FUNCTION usage_track_bandwidth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta bigint := NEW.bytes_out - CASE WHEN TG_OP = 'UPDATE' THEN OLD.bytes_out ELSE 0 END;
BEGIN
  IF delta <= 0 THEN RETURN NULL; END IF;
  INSERT INTO usage_bandwidth_daily (service_id, workspace_id, day, bytes_out)
  SELECT NEW.service_id, s.workspace_id, (NEW.minute AT TIME ZONE 'UTC')::date, delta FROM services s WHERE s.id = NEW.service_id
  ON CONFLICT (service_id, day) DO UPDATE SET bytes_out = usage_bandwidth_daily.bytes_out + EXCLUDED.bytes_out;
  RETURN NULL;
END $$;

CREATE TRIGGER usage_http_metrics AFTER INSERT OR UPDATE OF bytes_out ON http_metrics
  FOR EACH ROW EXECUTE FUNCTION usage_track_bandwidth();

-- Backfill from what is still on record.
INSERT INTO usage_resources (id, workspace_id, kind, name, type)
  SELECT id, workspace_id, 'service', name, type FROM services
  UNION ALL SELECT id, workspace_id, 'database', name, NULL FROM databases
  UNION ALL SELECT id, workspace_id, 'key_value', name, NULL FROM key_values;
INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, plan, started_at, ended_at)
  SELECT s.workspace_id, 'instance', s.id, i.id, s.plan, i.started_at, i.stopped_at
  FROM instances i JOIN services s ON s.id = i.service_id WHERE i.status <> 'pending';
INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, quantity, started_at)
  SELECT workspace_id, 'disk', id, id, COALESCE((disk->>'sizeGB')::double precision, 0), created_at FROM services WHERE disk IS NOT NULL;
INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, plan, quantity, started_at)
  SELECT workspace_id, 'database', id, id, plan, disk_gb, created_at FROM databases WHERE status IN ('available','restoring');
INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, plan, started_at)
  SELECT workspace_id, 'key_value', id, id, plan, created_at FROM key_values WHERE status = 'available';
INSERT INTO usage_periods (workspace_id, kind, resource_id, ref_id, started_at, ended_at)
  SELECT s.workspace_id, 'build', s.id, d.id, d.started_at, GREATEST(d.started_at, usage_build_end(d))
  FROM deploys d JOIN services s ON s.id = d.service_id WHERE d.started_at IS NOT NULL AND usage_build_end(d) IS NOT NULL;
INSERT INTO usage_bandwidth_daily (service_id, workspace_id, day, bytes_out)
  SELECT h.service_id, s.workspace_id, (h.minute AT TIME ZONE 'UTC')::date, sum(h.bytes_out)
  FROM http_metrics h JOIN services s ON s.id = h.service_id GROUP BY 1, 2, 3 HAVING sum(h.bytes_out) > 0;

-- Key Value external access over TLS: the agent runs a TLS-terminating proxy on tls_port (stable across restarts)
-- for instances with an IP allow list. tls_cert records which certificate it serves: 'platform' (the apps-domain
-- wildcard) or 'self-signed' (generated per node); tls_fingerprint is the SHA-256 of that certificate.
ALTER TABLE key_values ADD COLUMN tls_port integer;
ALTER TABLE key_values ADD COLUMN tls_cert text CHECK (tls_cert IN ('platform','self-signed'));
ALTER TABLE key_values ADD COLUMN tls_fingerprint text;
