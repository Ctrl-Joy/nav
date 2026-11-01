-- Log streams (syslog over TLS/TCP, or HTTPS) and OpenTelemetry metrics export.

CREATE TABLE log_streams (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_id   text REFERENCES services(id) ON DELETE CASCADE,  -- null: the workspace default
  protocol     text NOT NULL CHECK (protocol IN ('syslog-tls','syslog-tcp','https')),
  endpoint     text NOT NULL,                                   -- host:port, or a URL for https
  token_enc    text,                                            -- sent as syslog structured data or a Bearer header
  enabled      boolean NOT NULL DEFAULT true,                   -- a service override with enabled=false opts out
  last_error   text,
  last_sent_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX log_streams_scope ON log_streams(workspace_id, COALESCE(service_id, ''));

CREATE TABLE metrics_streams (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,              -- OTLP/HTTP base URL, e.g. https://otlp.example.com (we POST /v1/metrics)
  headers_enc  text,                       -- JSON object of extra headers (API keys), encrypted
  enabled      boolean NOT NULL DEFAULT true,
  last_error   text,
  last_sent_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
