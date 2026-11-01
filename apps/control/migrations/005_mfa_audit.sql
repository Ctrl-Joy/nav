-- Two-factor authentication, workspace login settings and the audit log.

ALTER TABLE users ADD COLUMN totp_secret_enc text;          -- active authenticator secret (encrypted)
ALTER TABLE users ADD COLUMN totp_pending_enc text;         -- secret being enrolled, until a code confirms it
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_counter bigint;      -- last accepted time step: a code works once
ALTER TABLE users ADD COLUMN recovery_codes jsonb NOT NULL DEFAULT '[]'; -- sha256 of unused recovery codes

-- A password (or OAuth) sign-in waiting for its second factor.
CREATE TABLE mfa_challenges (
  id         text PRIMARY KEY,                -- sha256(token); the token lives in an httpOnly cookie
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next       text,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);

ALTER TABLE workspaces ADD COLUMN require_2fa boolean NOT NULL DEFAULT false;

-- Who did what, from where. Kept apart from the activity feed: append-only and never shown to non-admins.
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  workspace_id text,
  actor_id     text,
  actor_email  text,
  actor_kind   text NOT NULL DEFAULT 'session',   -- session | api_key | system
  action       text NOT NULL,                     -- e.g. service.update, member.invite
  target_type  text,
  target_id    text,
  ip           text,
  user_agent   text,
  data         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_ws ON audit_logs(workspace_id, created_at DESC);
