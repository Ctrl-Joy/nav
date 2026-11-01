---
page_title: "nav_postgres Resource - NAV"
description: |-
  A managed PostgreSQL database.
---

# nav_postgres (Resource)

By default Terraform waits (up to 15 minutes) for the database to become `available`, then reads its connection
details from `GET /databases/:id/credentials` (developer access or above).

## Example Usage

```terraform
resource "nav_postgres" "db" {
  name       = "shop-db"
  plan       = "basic-1gb"
  pg_version = 17
  disk_gb    = 10

  ip_allow_list = [
    { cidr = "203.0.113.0/24", description = "office" },
  ]
}
```

## Schema

### Required

- `name` (String)

### Optional

- `workspace_id` (String) **Forces replacement.**
- `environment_id` (String) **Forces replacement.**
- `plan` (String) `free`, `basic-256mb` (default), `basic-1gb`, `pro-4gb`, `pro-8gb`.
- `pg_version` (Number) 14-18, default 17. **Forces replacement.**
- `database_name`, `user` (String) Lower-case identifiers; derived from `name` when unset. **Force replacement.**
- `disk_gb` (Number) 1-4096, default 1. Can only grow; lowering it **forces replacement**.
- `ip_allow_list` (Attributes List) `cidr` (IPv4 CIDR), `description`. Enables external access.
- `wait_for_available` (Bool) Default `true`.

### Read-Only

- `id`, `slug`, `status`, `host`, `port`
- `password`, `internal_connection_string`, `external_connection_string` (Sensitive)

## Import

```shell
terraform import nav_postgres.db dpg_abc123
```
