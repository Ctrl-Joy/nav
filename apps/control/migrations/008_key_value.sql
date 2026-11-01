-- Key Value: managed Redis-compatible (Valkey) instances.
CREATE TABLE key_values (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id text REFERENCES environments(id) ON DELETE SET NULL,
  name           text NOT NULL,
  slug           text NOT NULL UNIQUE,
  plan           text NOT NULL DEFAULT 'free',
  maxmemory_policy text NOT NULL DEFAULT 'allkeys-lru',
  password_enc   text NOT NULL,
  ip_allow_list  jsonb NOT NULL DEFAULT '[]',     -- external access: empty = internal only
  status         text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','available','suspended','failed','deleting')),
  driver         text,
  node_id        text,
  ref            text,                            -- container id or pid
  host           text,
  port           integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX key_values_ws ON key_values(workspace_id);
