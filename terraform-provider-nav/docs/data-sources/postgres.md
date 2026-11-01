---
page_title: "nav_postgres Data Source - NAV"
description: |-
  Looks up a PostgreSQL database and its connection details.
---

# nav_postgres (Data Source)

Connection details come from `GET /databases/:id/credentials`, which needs developer access and a database that is
`available` or `suspended`.

## Example Usage

```terraform
data "nav_postgres" "main" {
  name = "shop-db"
}

resource "nav_env_group" "db" {
  name     = "db"
  env_vars = { DATABASE_URL = data.nav_postgres.main.internal_connection_string }
}
```

## Schema

### Optional

- `id` (String) Set this or `name`.
- `name` (String)
- `workspace_id` (String) Defaults to the provider's.

### Read-Only

- `plan`, `pg_version`, `status`, `port`, `database_name`, `user`
- `host`, `password`, `internal_connection_string`, `external_connection_string`, `psql_command` (Sensitive)
