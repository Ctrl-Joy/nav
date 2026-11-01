-- Security hardening.

-- Pull request previews of forks: they run code from outside the team and never get the parent's secrets.
ALTER TABLE services ADD COLUMN untrusted boolean NOT NULL DEFAULT false;
ALTER TABLE preview_environments ADD COLUMN untrusted boolean NOT NULL DEFAULT false;

-- Whether a sandbox's egress is kept off private networks and its node by host firewall rules (agent-reported).
ALTER TABLE sandboxes ADD COLUMN egress_filtered boolean NOT NULL DEFAULT false;

-- Active-run limits per workflow / workspace are counted on every run creation and fan-out.
CREATE INDEX workflow_runs_active_service ON workflow_runs(service_id) WHERE status IN ('queued','running','waiting');

-- Organization invitations: nobody becomes an org member without accepting.
CREATE TABLE org_invites (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','admin','member')),
  invited_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_at timestamptz
);
CREATE UNIQUE INDEX org_invites_pending ON org_invites(org_id, lower(email)) WHERE accepted_at IS NULL;
CREATE INDEX org_invites_email ON org_invites(lower(email)) WHERE accepted_at IS NULL;
