-- Inbound IP rules and edge caching for web services, graceful shutdown delay, private registry credentials.

ALTER TABLE services ADD COLUMN ip_allow_list jsonb NOT NULL DEFAULT '[]';           -- [{cidr, description}]; empty = everyone
ALTER TABLE services ADD COLUMN edge_cache jsonb NOT NULL DEFAULT '{"enabled": false}';
ALTER TABLE services ADD COLUMN cache_epoch integer NOT NULL DEFAULT 0;               -- bump to purge the edge cache
ALTER TABLE services ADD COLUMN shutdown_delay_s integer NOT NULL DEFAULT 30 CHECK (shutdown_delay_s BETWEEN 1 AND 300);
ALTER TABLE services ADD COLUMN registry_credential_id text;

CREATE TABLE registry_credentials (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  registry     text NOT NULL,          -- docker.io, ghcr.io, registry.gitlab.com, <account>.dkr.ecr...
  username     text NOT NULL,
  password_enc text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE OR REPLACE VIEW edge_routes AS
  SELECT s.id AS service_id, s.slug, s.type, s.suspended, s.maintenance_mode, s.status,
         s.static_headers, s.static_routes,
         d.artifact,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'host', i.host, 'port', i.port) ORDER BY i.id)
                   FROM instances i WHERE i.service_id = s.id AND i.status = 'healthy'), '[]'::json) AS upstreams,
         COALESCE((SELECT json_agg(json_build_object('domain', c.domain, 'redirectTo', c.redirect_to))
                   FROM custom_domains c WHERE c.service_id = s.id AND c.verification_status = 'verified'), '[]'::json) AS domains,
         s.ip_allow_list, s.edge_cache, s.cache_epoch, s.current_deploy_id AS deploy_id
  FROM services s
  LEFT JOIN deploys d ON d.id = s.current_deploy_id
  WHERE s.type IN ('web','static');
