-- Platform wildcard certificate (*.<apps domain> + <apps domain>), issued with ACME DNS-01. The certificate
-- itself is stored in `certificates` under the domain '*.<apps domain>'; this table tracks issuance status.
CREATE TABLE platform_tls (
  domain          text PRIMARY KEY,            -- the apps domain
  provider        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issuing','issued','failed')),
  last_error      text,
  last_attempt_at timestamptz,
  issued_at       timestamptz,
  acme_directory  text,                        -- directory of the stored certificate: switching staging -> production re-issues
  updated_at      timestamptz NOT NULL DEFAULT now()
);
