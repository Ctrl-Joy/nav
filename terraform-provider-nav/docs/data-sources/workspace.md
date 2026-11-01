---
page_title: "nav_workspace Data Source - NAV"
description: |-
  Looks up a workspace the API key can access.
---

# nav_workspace (Data Source)

## Example Usage

```terraform
data "nav_workspace" "current" {}           # the provider's workspace_id

data "nav_workspace" "team" {
  slug = "platform-team"
}
```

## Schema

### Optional

- `id`, `name`, `slug` (String) Filters; with none set the provider's `workspace_id` is used. Exactly one workspace must match.

### Read-Only

- `role` (String) Your role in the workspace.
- `created_at` (String)
