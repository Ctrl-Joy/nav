-- Free instance sleep: free-plan web services spin down after a quiet period and the edge wakes them on demand.

ALTER TABLE services ADD COLUMN sleeping boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN last_request_at timestamptz;   -- batch-written by the edge (metrics flush)

CREATE OR REPLACE VIEW edge_routes AS
  SELECT s.id AS service_id, s.slug, s.type, s.suspended, s.maintenance_mode, s.status,
         s.static_headers, s.static_routes,
         d.artifact,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'host', i.host, 'port', i.port) ORDER BY i.id)
                   FROM instances i WHERE i.service_id = s.id AND i.status = 'healthy'), '[]'::json) AS upstreams,
         COALESCE((SELECT json_agg(json_build_object('domain', c.domain, 'redirectTo', c.redirect_to))
                   FROM custom_domains c WHERE c.service_id = s.id AND c.verification_status = 'verified'), '[]'::json) AS domains,
         s.ip_allow_list, s.edge_cache, s.cache_epoch, s.current_deploy_id AS deploy_id,
         s.sleeping
  FROM services s
  LEFT JOIN deploys d ON d.id = s.current_deploy_id
  WHERE s.type IN ('web','static');
