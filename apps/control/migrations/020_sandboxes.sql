-- Sandboxes: short-lived, isolated environments where code (for example from AI agents) runs through the API.
-- A sandbox lives on one node; the agent there holds its filesystem and runs its commands. It is torn down when
-- deleted or when its TTL passes. Snapshots archive a sandbox's /workspace into the artifact store.
CREATE TABLE sandboxes (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             text,
  runtime          text CHECK (runtime IN ('node','python','bash')),
  image            text NOT NULL,
  plan             text NOT NULL DEFAULT 'small',
  network_access   text NOT NULL DEFAULT 'none' CHECK (network_access IN ('none','egress')),
  status           text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','stopping','stopped','expired','failed')),
  node_id          text REFERENCES nodes(id) ON DELETE SET NULL,
  driver           text,
  env_keys         text[] NOT NULL DEFAULT '{}',      -- names only: values go to the node and are never stored
  from_snapshot_id text,
  ttl_seconds      integer NOT NULL,
  expires_at       timestamptz NOT NULL,
  exec_count       integer NOT NULL DEFAULT 0,
  last_exec_at     timestamptz,
  error            text,
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  stopped_at       timestamptz
);
CREATE INDEX sandboxes_workspace ON sandboxes(workspace_id, created_at DESC);
CREATE INDEX sandboxes_live_expiry ON sandboxes(expires_at) WHERE status IN ('starting','running');

CREATE TABLE sandbox_snapshots (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sandbox_id   text REFERENCES sandboxes(id) ON DELETE SET NULL,
  name         text,
  runtime      text,
  image        text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  store        jsonb,                                  -- {key, digest, size} in the artifact store
  size_bytes   bigint,
  error        text,
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX sandbox_snapshots_workspace ON sandbox_snapshots(workspace_id, created_at DESC);

-- Per-workspace override of the live sandbox limit (NULL: the platform default).
ALTER TABLE workspaces ADD COLUMN sandbox_limit integer CHECK (sandbox_limit IS NULL OR sandbox_limit >= 0);
