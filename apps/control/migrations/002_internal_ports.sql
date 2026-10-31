-- Stable private-network port per web/private service (process driver: agent-local TCP load balancer).
ALTER TABLE services ADD COLUMN internal_port integer UNIQUE;
-- Free-tier idle tracking (spin down after inactivity, wake on request).
ALTER TABLE services ADD COLUMN last_request_at timestamptz;
CREATE INDEX jobs_kind_payload ON jobs(kind, (payload->>'serviceId')) WHERE status IN ('queued','running');
