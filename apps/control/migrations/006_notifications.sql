-- Signed outbound webhooks with delivery history, and email notifications.

CREATE TABLE webhooks (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  url          text NOT NULL,
  secret_enc   text NOT NULL,             -- whsec_… signing secret (encrypted)
  events       text[] NOT NULL DEFAULT '{}', -- empty: every event
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_ws ON webhooks(workspace_id);

CREATE TABLE webhook_deliveries (
  id           bigserial PRIMARY KEY,
  webhook_id   text NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id     bigint,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  status_code  integer,
  error        text,
  duration_ms  integer,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, id DESC);

ALTER TABLE notification_settings ADD COLUMN email_notify_on text NOT NULL DEFAULT 'failure' CHECK (email_notify_on IN ('all','failure','none'));
ALTER TABLE users ADD COLUMN email_notifications boolean NOT NULL DEFAULT true;
