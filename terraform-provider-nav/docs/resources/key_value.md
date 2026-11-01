---
page_title: "nav_key_value Resource - NAV"
description: |-
  A Redis-compatible Key Value instance.
---

# nav_key_value (Resource)

## Example Usage

```terraform
resource "nav_key_value" "cache" {
  name             = "cache"
  plan             = "starter"
  maxmemory_policy = "allkeys-lru"
}
```

## Schema

### Required

- `name` (String)

### Optional

- `workspace_id`, `environment_id` (String) **Force replacement.**
- `plan` (String) `free` (default), `starter`, `standard`, `pro`, `pro-plus`.
- `maxmemory_policy` (String) Default `allkeys-lru`; any Redis eviction policy.
- `ip_allow_list` (Attributes List) `cidr`, `description`. Enables external access.
- `wait_for_available` (Bool) Default `true` (waits up to 15 minutes after creation).

### Read-Only

- `id`, `slug`, `status`
- `password`, `internal_connection_string`, `external_connection_string` (Sensitive; the external one is null without an allow list)

## Import

```shell
terraform import nav_key_value.cache kv_abc123
```
