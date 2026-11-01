---
page_title: "nav_registry_credential Resource - NAV"
description: |-
  Credentials for a private container registry.
---

# nav_registry_credential (Resource)

Used by image-backed services through `nav_service.registry_credential_id`. NAV never returns the password, so changes
made to it outside Terraform are not detected. Requires admin access.

## Example Usage

```terraform
resource "nav_registry_credential" "ghcr" {
  name     = "ghcr"
  registry = "ghcr.io"
  username = "acme-bot"
  password = var.ghcr_token
}
```

## Schema

### Required

- `name` (String)
- `registry` (String) Lower-case host, optionally with port/path.
- `username` (String)
- `password` (String, Sensitive)

### Optional

- `workspace_id` (String) **Forces replacement.**

### Read-Only

- `id` (String)

## Import

```shell
terraform import nav_registry_credential.ghcr reg_abc123
```

The password is not imported; the next apply sets it from configuration.
