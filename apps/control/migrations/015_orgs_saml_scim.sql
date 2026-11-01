-- Organizations: an org owns several workspaces and has its own members (owner | admin | member). Org owners and
-- admins act as workspace owners/admins in every workspace of the org. Workspaces without an org keep working as before.
-- Orgs prove ownership of email domains (DNS TXT); verified domains gate SAML single sign-on and SCIM provisioning.

CREATE TABLE orgs (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  slug         text NOT NULL UNIQUE,
  require_2fa  boolean NOT NULL DEFAULT false,
  default_role text NOT NULL DEFAULT 'developer' CHECK (default_role IN ('admin','developer','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id     text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members(user_id);

ALTER TABLE workspaces ADD COLUMN org_id text REFERENCES orgs(id) ON DELETE RESTRICT;
CREATE INDEX workspaces_org ON workspaces(org_id);
-- Where SSO / SCIM users land (with orgs.default_role).
ALTER TABLE orgs ADD COLUMN default_workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;

-- Workspace memberships granted by a SCIM group mapping; only these are removed when the group mapping changes.
ALTER TABLE workspace_members ADD COLUMN scim_managed boolean NOT NULL DEFAULT false;

CREATE TABLE org_domains (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  verify_token    text NOT NULL,              -- published as TXT "nav-verify=<token>" on _nav-verify.<domain>
  verified_at     timestamptz,
  last_checked_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, domain)
);
-- A domain can be verified by one org only.
CREATE UNIQUE INDEX org_domains_verified ON org_domains(domain) WHERE verified_at IS NOT NULL;

CREATE TABLE saml_configs (
  org_id          text PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  enforce         boolean NOT NULL DEFAULT false,  -- verified-domain accounts must sign in through SAML
  idp_entity_id   text,
  idp_sso_url     text,
  idp_certs       jsonb NOT NULL DEFAULT '[]',     -- PEM signing certificates (several during a rollover)
  request_binding text NOT NULL DEFAULT 'redirect' CHECK (request_binding IN ('redirect','post')),
  sp_cert         text NOT NULL,                   -- signs our AuthnRequests; published in SP metadata
  sp_key_enc      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Outstanding AuthnRequests: a response is accepted once, only InResponseTo one of these (replay protection).
CREATE TABLE saml_requests (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  next       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE scim_tokens (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE scim_users (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name    text NOT NULL,
  external_id  text,
  given_name   text,
  family_name  text,
  display_name text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  UNIQUE (org_id, user_name)
);

CREATE TABLE scim_groups (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  external_id  text,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,   -- members get `role` in this workspace
  role         text CHECK (role IN ('admin','developer','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, display_name)
);

CREATE TABLE scim_group_members (
  group_id     text NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  scim_user_id text NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, scim_user_id)
);

ALTER TABLE audit_logs ADD COLUMN org_id text;
CREATE INDEX audit_logs_org ON audit_logs(org_id, created_at DESC);
