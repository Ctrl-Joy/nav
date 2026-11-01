---
page_title: "nav_env_group Resource - NAV"
description: |-
  A shared group of environment variables and secret files.
---

# nav_env_group (Resource)

Services link to groups with `nav_service.env_group_ids`. Changing a group's variables or files redeploys every
linked live service.

## Example Usage

```terraform
resource "nav_env_group" "shared" {
  name = "shared"
  env_vars = {
    DATABASE_URL = nav_postgres.db.internal_connection_string
    LOG_LEVEL    = "info"
  }
  secret_files = {
    "ca.pem" = file("ca.pem")
  }
}
```

## Schema

### Required

- `name` (String)

### Optional

- `workspace_id` (String) **Forces replacement.**
- `env_vars` (Map of String, Sensitive) Full set when present; unmanaged when omitted; removing it after it was set clears the variables.
- `secret_files` (Map of String, Sensitive) File name to content, same semantics.

### Read-Only

- `id` (String)

## Import

```shell
terraform import nav_env_group.shared evg_abc123
```

Contents are not imported; add `env_vars` / `secret_files` to adopt them.
