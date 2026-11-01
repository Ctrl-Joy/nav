-- NAV Workflows: durable background tasks. A workflow is a service of type 'workflow', built and deployed like any
-- other service; its tasks are discovered at deploy time and each run executes as a one-off process / container.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_type_check;
ALTER TABLE services ADD CONSTRAINT services_type_check CHECK (type IN ('web','private','worker','cron','static','workflow'));
-- At most this many runs of the workflow execute at once (waiting runs hold no slot).
ALTER TABLE services ADD COLUMN workflow_concurrency integer NOT NULL DEFAULT 10 CHECK (workflow_concurrency BETWEEN 1 AND 100);

-- Tasks reported by the build's "describe" mode, per deploy. Runs use the tasks of the deploy they were created on.
CREATE TABLE workflow_tasks (
  deploy_id           text NOT NULL REFERENCES deploys(id) ON DELETE CASCADE,
  service_id          text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name                text NOT NULL,
  retries             integer NOT NULL DEFAULT 0,
  timeout_s           double precision NOT NULL DEFAULT 3600,
  backoff_s           double precision NOT NULL DEFAULT 5,
  max_backoff_s       double precision NOT NULL DEFAULT 600,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deploy_id, name)
);
CREATE INDEX workflow_tasks_service ON workflow_tasks(service_id);

-- status: queued -> running -> succeeded | failed | canceled. A run that is waiting for its subtasks or a sleep is
-- 'waiting' (it holds no process and no concurrency slot) and goes back to running when they are done.
CREATE TABLE workflow_runs (
  id                 text PRIMARY KEY,
  service_id         text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  deploy_id          text REFERENCES deploys(id) ON DELETE SET NULL,
  task               text NOT NULL,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','succeeded','failed','canceled')),
  input              jsonb,
  output             jsonb,
  error              text,
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 1,
  timeout_s          double precision NOT NULL DEFAULT 3600,
  backoff_s          double precision NOT NULL DEFAULT 5,
  max_backoff_s      double precision NOT NULL DEFAULT 600,
  parent_run_id      text REFERENCES workflow_runs(id) ON DELETE CASCADE,
  root_run_id        text,
  depth              integer NOT NULL DEFAULT 0,
  idempotency_key    text,
  trigger            text NOT NULL DEFAULT 'api',    -- dashboard|api|cli|service|subtask|retry
  retry_of           text,
  created_by         text REFERENCES users(id) ON DELETE SET NULL,
  -- One entry per execution of the task code: {attempt, kind: start|resume, startedAt, finishedAt, outcome, error}.
  executions         jsonb NOT NULL DEFAULT '[]',
  next_attempt_at    timestamptz,                      -- earliest start of the next attempt (retry backoff)
  wake_at            timestamptz,                      -- earliest resume for a waiting run (durable sleep)
  attempt_started_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_service ON workflow_runs(service_id, created_at DESC);
CREATE INDEX workflow_runs_parent ON workflow_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX workflow_runs_root ON workflow_runs(root_run_id) WHERE root_run_id IS NOT NULL;
CREATE INDEX workflow_runs_active ON workflow_runs(status) WHERE status IN ('queued','running','waiting');
CREATE UNIQUE INDEX workflow_runs_idempotency ON workflow_runs(service_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The replay journal: each ctx.run / ctx.sleep a run reached, in call order. Subtask steps point at their child run.
CREATE TABLE workflow_steps (
  run_id       text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('run','sleep')),
  task         text,
  child_run_id text REFERENCES workflow_runs(id) ON DELETE SET NULL,
  until        timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

-- Per-workflow concurrency is checked when an agent claims a run's job.
CREATE INDEX jobs_workflow_running ON jobs ((payload->>'serviceId')) WHERE status = 'running' AND kind = 'workflow_run';
