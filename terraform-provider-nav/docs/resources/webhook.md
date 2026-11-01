---
page_title: "nav_webhook Resource - NAV"
description: |-
  A workspace webhook that receives signed event deliveries.
---

# nav_webhook (Resource)

NAV POSTs signed JSON (Standard Webhooks headers) to `url`. Requires admin access.

## Example Usage

```terraform
resource "nav_webhook" "deploys" {
  name   = "deploy-notifications"
  url    = "https://hooks.example.com/nav"
  events = ["deploy_live", "deploy_failed"]
}
```

## Schema

### Required

- `name` (String)
- `url` (String) Public URL.

### Optional

- `workspace_id` (String) **Forces replacement.**
- `events` (Set of String) Event types, e.g. `deploy_live`, `deploy_failed`, `service_created`, `database_available`,
  `domain_verified`. Validated against the API's list. Defaults to an empty set.
- `enabled` (Bool) Default `true`.

### Read-Only

- `id` (String)
- `secret` (String, Sensitive) Signing secret; refreshed on every read so rotations show up.

## Import

```shell
terraform import nav_webhook.deploys whk_abc123
```
