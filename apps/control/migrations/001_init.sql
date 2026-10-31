-- NAV control-plane schema. All IDs are prefixed random strings (e.g. srv_8f3k...).
-- Secrets (env var values, DB passwords, private keys) are stored AES-256-GCM encrypted (*_enc columns).

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text,
  github_id     bigint UNIQUE,
  github_login  text,
  github_token_enc text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,           -- sha256(token)
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_keys (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','admin','developer','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_invites (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz
);

CREATE TABLE projects (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  protected  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE github_installations (
  id            bigint PRIMARY KEY,       -- GitHub App installation id
  workspace_id  text REFERENCES workspaces(id) ON DELETE CASCADE,
  account_login text NOT NULL,
  account_type  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id     text REFERENCES environments(id) ON DELETE SET NULL,
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,                     -- public subdomain + private hostname
  type               text NOT NULL CHECK (type IN ('web','private','worker','cron','static')),
  runtime            text NOT NULL CHECK (runtime IN ('auto','node','python','go','ruby','bun','docker','image','static')),
  repo_url           text,
  branch             text,
  root_dir           text NOT NULL DEFAULT '',
  installation_id    bigint,
  image_url          text,
  build_command      text,
  start_command      text,
  pre_deploy_command text,
  dockerfile_path    text NOT NULL DEFAULT 'Dockerfile',
  docker_context     text NOT NULL DEFAULT '.',
  publish_path       text,
  health_check_path  text,
  port               integer,
  plan               text NOT NULL DEFAULT 'starter',
  instance_count     integer NOT NULL DEFAULT 1 CHECK (instance_count BETWEEN 0 AND 100),
  autoscaling        jsonb NOT NULL DEFAULT '{"enabled":false,"min":1,"max":3,"targetCpuPercent":70,"targetMemoryPercent":null}',
  auto_deploy        text NOT NULL DEFAULT 'commit' CHECK (auto_deploy IN ('commit','off')),
  build_filter       jsonb NOT NULL DEFAULT '{"paths":[],"ignoredPaths":[]}',
  cron_schedule      text,
  disk               jsonb,                                    -- {name, mountPath, sizeGB}
  static_headers     jsonb NOT NULL DEFAULT '[]',              -- [{path, name, value}]
  static_routes      jsonb NOT NULL DEFAULT '[]',              -- [{type: redirect|rewrite, source, destination}]
  previews           jsonb NOT NULL DEFAULT '{"mode":"off","expireAfterDays":7}',
  parent_service_id  text REFERENCES services(id) ON DELETE CASCADE,
  pr_number          integer,
  deploy_hook_token  text NOT NULL,
  suspended          boolean NOT NULL DEFAULT false,
  maintenance_mode   boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'created',          -- created|deploying|live|failed|suspended|sleeping
  current_deploy_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_workspace ON services(workspace_id);
CREATE INDEX services_repo ON services(repo_url, branch);

CREATE TABLE env_groups (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id text REFERENCES environments(id) ON DELETE SET NULL,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE service_env_groups (
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  group_id   text NOT NULL REFERENCES env_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, group_id)
);

-- owner_type: service | group
CREATE TABLE env_vars (
  id         text PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('service','group')),
  owner_id   text NOT NULL,
  key        text NOT NULL,
  value_enc  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, key)
);

CREATE TABLE secret_files (
  id          text PRIMARY KEY,
  owner_type  text NOT NULL CHECK (owner_type IN ('service','group')),
  owner_id    text NOT NULL,
  filename    text NOT NULL,
  content_enc text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, filename)
);

CREATE TABLE deploys (
  id                text PRIMARY KEY,
  service_id        text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN (
                      'queued','build_in_progress','pre_deploy_in_progress','update_in_progress',
                      'live','deactivated','build_failed','pre_deploy_failed','update_failed','canceled')),
  trigger           text NOT NULL,          -- new_service|git_push|manual|api|rollback|deploy_hook|env_change|blueprint|preview|config_change
  commit_sha        text,
  commit_message    text,
  commit_author     text,
  branch            text,
  clear_cache       boolean NOT NULL DEFAULT false,
  rollback_of       text REFERENCES deploys(id) ON DELETE SET NULL,
  artifact          jsonb,                  -- {kind:'image', ref} | {kind:'dir', path, runtime}
  config            jsonb,                  -- snapshot of build/start config used
  error             text,
  created_by        text REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  build_finished_at timestamptz,
  finished_at       timestamptz
);
CREATE INDEX deploys_service ON deploys(service_id, created_at DESC);

ALTER TABLE services ADD CONSTRAINT services_current_deploy FOREIGN KEY (current_deploy_id) REFERENCES deploys(id) ON DELETE SET NULL;

-- Durable job queue consumed by node agents with SELECT ... FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','canceled')),
  concurrency_key text,                       -- at most one running job per key (e.g. service id)
  run_at      timestamptz NOT NULL DEFAULT now(),
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  locked_by   text,
  locked_at   timestamptz,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready ON jobs(status, run_at) WHERE status = 'queued';
CREATE INDEX jobs_concurrency ON jobs(concurrency_key) WHERE status = 'running';

CREATE TABLE nodes (
  id             text PRIMARY KEY,
  hostname       text NOT NULL,
  driver         text NOT NULL,
  address        text NOT NULL DEFAULT '127.0.0.1',
  capacity       jsonb NOT NULL DEFAULT '{}',
  last_heartbeat timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instances (
  id             text PRIMARY KEY,
  service_id     text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  deploy_id      text NOT NULL REFERENCES deploys(id) ON DELETE CASCADE,
  node_id        text NOT NULL,
  driver         text NOT NULL,
  ref            text,                       -- container id or pid
  host           text NOT NULL DEFAULT '127.0.0.1',
  port           integer,
  status         text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','healthy','unhealthy','draining','stopped','crashed')),
  restart_count  integer NOT NULL DEFAULT 0,
  last_exit_code integer,
  started_at     timestamptz NOT NULL DEFAULT now(),
  stopped_at     timestamptz
);
CREATE INDEX instances_service ON instances(service_id) WHERE status <> 'stopped';

CREATE TABLE logs (
  id          bigserial PRIMARY KEY,
  service_id  text,
  database_id text,
  deploy_id   text,
  instance_id text,
  run_id      text,
  stream      text NOT NULL,              -- build | deploy | runtime | cron | job | system
  level       text NOT NULL DEFAULT 'info',
  message     text NOT NULL,
  ts          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX logs_service ON logs(service_id, id);
CREATE INDEX logs_deploy ON logs(deploy_id, id) WHERE deploy_id IS NOT NULL;
CREATE INDEX logs_ts ON logs(ts);

CREATE TABLE metrics (
  service_id  text NOT NULL,
  instance_id text NOT NULL,
  ts          timestamptz NOT NULL,
  cpu         double precision NOT NULL,  -- cores in use (1.0 == one full core)
  mem_bytes   bigint NOT NULL
);
CREATE INDEX metrics_service_ts ON metrics(service_id, ts);

CREATE TABLE http_metrics (
  service_id text NOT NULL,
  minute     timestamptz NOT NULL,
  requests   integer NOT NULL DEFAULT 0,
  s2xx       integer NOT NULL DEFAULT 0,
  s3xx       integer NOT NULL DEFAULT 0,
  s4xx       integer NOT NULL DEFAULT 0,
  s5xx       integer NOT NULL DEFAULT 0,
  latency_ms_sum double precision NOT NULL DEFAULT 0,
  latency_ms_max double precision NOT NULL DEFAULT 0,
  bytes_out  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, minute)
);

-- Cron executions and one-off jobs.
CREATE TABLE runs (
  id          text PRIMARY KEY,
  service_id  text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  deploy_id   text REFERENCES deploys(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('cron','job')),
  command     text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','canceled')),
  trigger     text NOT NULL DEFAULT 'schedule',
  exit_code   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX runs_service ON runs(service_id, created_at DESC);

CREATE TABLE custom_domains (
  id                  text PRIMARY KEY,
  service_id          text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  domain              text NOT NULL UNIQUE,
  redirect_to         text,                -- e.g. www.example.com -> example.com
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','failed')),
  cert_status         text NOT NULL DEFAULT 'pending' CHECK (cert_status IN ('pending','issuing','issued','failed')),
  last_error          text,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE certificates (
  domain     text PRIMARY KEY,
  cert_pem   text NOT NULL,
  key_enc    text NOT NULL,
  issuer     text NOT NULL,
  not_after  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acme_challenges (
  token      text PRIMARY KEY,
  key_auth   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE databases (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id text REFERENCES environments(id) ON DELETE SET NULL,
  name           text NOT NULL,
  slug           text NOT NULL UNIQUE,
  plan           text NOT NULL DEFAULT 'basic-256mb',
  pg_version     integer NOT NULL DEFAULT 17,
  db_name        text NOT NULL,
  db_user        text NOT NULL,
  password_enc   text NOT NULL,
  disk_gb        integer NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','available','suspended','failed','deleting','restoring')),
  driver         text,
  node_id        text,
  ref            text,
  host           text,
  port           integer,
  ip_allow_list  jsonb NOT NULL DEFAULT '[{"cidr":"0.0.0.0/0","description":"everywhere"}]',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE db_backups (
  id          text PRIMARY KEY,
  database_id text NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('automatic','manual')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  path        text,
  size_bytes  bigint,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE blueprints (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           text NOT NULL,
  repo_url       text NOT NULL,
  branch         text NOT NULL,
  file_path      text NOT NULL DEFAULT 'nav.yaml',
  auto_sync      boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'pending',     -- pending|syncing|in_sync|error
  last_error     text,
  last_synced_at timestamptz,
  last_commit    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blueprint_resources (
  blueprint_id  text NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  resource_type text NOT NULL,               -- service|database|env_group
  resource_id   text NOT NULL,
  name          text NOT NULL,
  PRIMARY KEY (blueprint_id, resource_type, name)
);

-- Activity feed + audit log.
CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  service_id   text,
  database_id  text,
  actor_id     text,
  kind         text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_service ON events(service_id, id DESC);
CREATE INDEX events_workspace ON events(workspace_id, id DESC);

CREATE TABLE notification_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  webhook_url  text,
  notify_on    text NOT NULL DEFAULT 'failure'   -- all|failure|none
);

-- Routing table consumed by the edge proxy. One row per hostname with its upstreams.
CREATE VIEW edge_routes AS
  SELECT s.id AS service_id, s.slug, s.type, s.suspended, s.maintenance_mode, s.status,
         s.static_headers, s.static_routes,
         d.artifact,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'host', i.host, 'port', i.port) ORDER BY i.id)
                   FROM instances i WHERE i.service_id = s.id AND i.status = 'healthy'), '[]'::json) AS upstreams,
         COALESCE((SELECT json_agg(json_build_object('domain', c.domain, 'redirectTo', c.redirect_to))
                   FROM custom_domains c WHERE c.service_id = s.id AND c.verification_status = 'verified'), '[]'::json) AS domains
  FROM services s
  LEFT JOIN deploys d ON d.id = s.current_deploy_id
  WHERE s.type IN ('web','static');
