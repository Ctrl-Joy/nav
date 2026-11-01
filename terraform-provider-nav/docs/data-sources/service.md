---
page_title: "nav_service Data Source - NAV"
description: |-
  Looks up a service by ID or name.
---

# nav_service (Data Source)

## Example Usage

```terraform
data "nav_service" "api" {
  name = "api"
}

output "api_internal" {
  value = data.nav_service.api.internal_address
}
```

## Schema

### Optional

- `id` (String) Set this or `name`.
- `name` (String) Exactly one service with this name must exist in the workspace.
- `workspace_id` (String) Workspace searched by name. Defaults to the provider's.

### Read-Only

- `environment_id`, `type`, `runtime`, `repo_url`, `branch`, `image_url`, `plan`, `instance_count`, `slug`, `url`,
  `internal_address`, `status`, `suspended`
