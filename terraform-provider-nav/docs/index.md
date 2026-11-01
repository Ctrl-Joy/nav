---
page_title: "NAV Provider"
description: |-
  Manage NAV projects, services, databases, Key Value instances and related resources.
---

# NAV Provider

The NAV provider manages resources on a [NAV](https://github.com/Ctrl-Joy/nav) control plane through its REST API
(`/api/v1`). It authenticates with an API key (`nav_...`) created under account settings or with `POST /api/v1/api-keys`.

## Example Usage

```terraform
terraform {
  required_providers {
    nav = {
      source = "ctrl-joy/nav"
    }
  }
}

provider "nav" {
  host         = "https://nav.example.com" # or NAV_HOST
  api_key      = var.nav_api_key           # or NAV_TOKEN
  workspace_id = "ws_123"                  # or NAV_WORKSPACE
}
```

## Schema

### Optional

- `host` (String) Base URL of the control plane. `/api/v1` is appended. Defaults to `NAV_HOST`, then `http://localhost:4000`.
- `api_key` (String, Sensitive) API key. Defaults to `NAV_TOKEN`. Required in one of the two places.
- `workspace_id` (String) Default workspace for resources and data sources that do not set `workspace_id`. Defaults to `NAV_WORKSPACE`.

## Behaviour

- **Retries**: requests answered with `429` or `503` are retried with exponential backoff (honouring `Retry-After`);
  other `5xx` answers and network errors are retried for idempotent methods (GET, PUT, DELETE) only.
- **Drift**: every resource is refreshed from the API on plan. Resources deleted outside Terraform (`404`) are removed
  from state and recreated on the next apply.
- **Secrets**: env vars, secret files, passwords, tokens, connection strings and deploy hook URLs are sensitive and never
  shown in plan output (they are still stored in state; protect your state backend).
- **Roles**: reading credentials needs `developer`; webhooks, log streams, registry credentials and custom domains need `admin`.
