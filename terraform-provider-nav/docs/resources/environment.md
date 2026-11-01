---
page_title: "nav_environment Resource - NAV"
description: |-
  An environment inside a project.
---

# nav_environment (Resource)

The API cannot rename or edit environments, so every argument forces a new environment.

## Example Usage

```terraform
resource "nav_environment" "preview" {
  project_id = nav_project.shop.id
  name       = "preview"
  protected  = false
}
```

## Schema

### Required

- `project_id` (String) **Forces replacement.**
- `name` (String) **Forces replacement.**

### Optional

- `protected` (Bool) Default `false`. **Forces replacement.**
- `workspace_id` (String) Defaults to the provider's; used to look the environment up. **Forces replacement.**

### Read-Only

- `id` (String)

## Import

```shell
terraform import nav_environment.preview env_abc123
terraform import nav_environment.preview ws_123/env_abc123
```
