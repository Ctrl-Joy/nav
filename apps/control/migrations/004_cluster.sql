-- Multi-node clusters: jobs can target a node, instances are placed by the control plane, nodes can be drained.

ALTER TABLE jobs ADD COLUMN node_id text;
CREATE INDEX jobs_node ON jobs(node_id) WHERE status = 'queued';

ALTER TABLE nodes ADD COLUMN draining boolean NOT NULL DEFAULT false;
ALTER TABLE nodes ADD COLUMN version text;

-- pending: placed on a node, waiting for that node's agent to start it.
-- lost:    its node stopped heartbeating; the scheduler has replaced it elsewhere.
ALTER TABLE instances DROP CONSTRAINT IF EXISTS instances_status_check;
ALTER TABLE instances ADD CONSTRAINT instances_status_check
  CHECK (status IN ('pending','starting','healthy','unhealthy','draining','stopped','crashed','lost'));
CREATE INDEX instances_node ON instances(node_id) WHERE status <> 'stopped';

-- A persistent disk lives on one node; services with a disk are pinned to it after their first placement.
ALTER TABLE services ADD COLUMN node_id text;
