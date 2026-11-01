-- Sign-in provider credentials an instance administrator saves from the dashboard (Admin -> Sign-in providers).
-- Environment variables (NAV_GITHUB_CLIENT_ID, NAV_GITLAB_CLIENT_ID, ...) still win over a row here.
-- The client secret is encrypted with NAV_MASTER_KEY and never leaves the server.

CREATE TABLE auth_provider_settings (
  provider          text PRIMARY KEY CHECK (provider IN ('github', 'gitlab', 'bitbucket', 'google')),
  client_id         text NOT NULL,
  client_secret_enc text NOT NULL,
  base_url          text,                -- GitLab only: a self-managed instance, e.g. https://gitlab.example.com
  updated_by        text REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
