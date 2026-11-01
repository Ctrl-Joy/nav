---
page_title: "nav_project Resource - NAV"
description: |-
  A project: a named group of environments.
---

# nav_project (Resource)

## Example Usage

```terraform
resource "nav_project" "shop" {
  name                 = "shop"
  initial_environments = ["production", "staging"]
}

resource "nav_service" "web" {
  # ...
  environment_id = nav_project.shop.environment_ids["production"]
}
```

## Schema

### Required

- `name` (String)

### Optional

- `workspace_id` (String) Defaults to the provider's. **Forces replacement.**
- `initial_environments` (List of String) Environments created with the project (NAV's default is `["production"]`).
  Only used at creation; changing it forces a new project. Not compared after an import.

### Read-Only

- `id` (String)
- `environment_ids` (Map of String) Environment name to ID for every environment, including ones added with `nav_environment`.

Deleting a project detaches its services; it does not delete them.

## Import

```shell
terraform import nav_project.shop prj_abc123
terraform import nav_project.shop ws_123/prj_abc123   # another workspace
```
