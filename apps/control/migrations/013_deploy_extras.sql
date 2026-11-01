-- Auto-deploy after CI checks pass, and whole-stack (blueprint) preview environments per pull request.

-- 'checks': a push is recorded as pending and deployed once every GitHub check / status on the commit succeeded.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_auto_deploy_check;
ALTER TABLE services ADD CONSTRAINT services_auto_deploy_check CHECK (auto_deploy IN ('commit','checks','off'));

-- The newest pushed commit of a 'checks' service that is waiting for its checks (one per service).
CREATE TABLE pending_check_deploys (
  service_id     text PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  commit_sha     text NOT NULL,
  commit_message text,
  commit_author  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_check_deploys_sha ON pending_check_deploys(commit_sha);

-- Blueprint-level preview settings (nav.yaml `previews:`): generation off|manual|automatic.
ALTER TABLE blueprints ADD COLUMN previews jsonb NOT NULL DEFAULT '{"generation":"off","expireAfterDays":7}';

-- One preview copy of a blueprint's whole stack for a pull request.
CREATE TABLE preview_environments (
  id           text PRIMARY KEY,
  blueprint_id text NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pr_number    integer NOT NULL,
  pr_title     text,
  branch       text NOT NULL,
  commit_sha   text,
  status       text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','failed','deleting')),
  error        text,
  resources    jsonb NOT NULL DEFAULT '[]',          -- [{type: service|database|env_group, id, name}]
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, pr_number)
);
CREATE INDEX preview_environments_resources ON preview_environments USING gin (resources jsonb_path_ops);
