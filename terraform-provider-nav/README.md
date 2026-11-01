# Terraform Provider for NAV

A Terraform provider for [NAV](../README.md), built with the
[Terraform Plugin Framework](https://developer.hashicorp.com/terraform/plugin/framework). It manages NAV resources
through the REST API (`/api/v1`, see [`docs/API.md`](../docs/API.md)).

| Resources | Data sources |
|---|---|
| `nav_project`, `nav_environment`, `nav_service`, `nav_custom_domain`, `nav_env_group`, `nav_postgres`, `nav_key_value`, `nav_registry_credential`, `nav_webhook`, `nav_log_stream` | `nav_workspace`, `nav_service`, `nav_postgres` |

Docs for each resource are in [`docs/`](docs/), in Terraform Registry format. A complete example (web service + worker
+ Postgres + Key Value + env group + custom domain) is in [`examples/full-stack`](examples/full-stack).

## Requirements

- Go 1.23+
- Terraform 1.5+ (or OpenTofu 1.6+)
- A NAV API key (`nav_...`): Account settings → API keys, or `POST /api/v1/api-keys`

## Build

```sh
cd terraform-provider-nav
go mod tidy          # resolves indirect dependencies and writes go.sum
go build -o terraform-provider-nav .
```

Set a version with `go build -ldflags "-X main.version=0.1.0" .`

## Install for local development (dev_overrides)

Install the binary into your `GOBIN`:

```sh
go install .
go env GOBIN   # empty means $(go env GOPATH)/bin
```

Then tell Terraform to use it instead of the registry. Put this in `~/.terraformrc`
(on Windows: `%APPDATA%\terraform.rc`):

```hcl
provider_installation {
  dev_overrides {
    "ctrl-joy/nav" = "/home/you/go/bin"   # the directory that holds terraform-provider-nav
  }
  direct {}
}
```

With dev overrides, skip `terraform init` and run `terraform plan` / `apply` directly; Terraform prints a warning that
the override is active.

## Configure

```hcl
terraform {
  required_providers {
    nav = { source = "ctrl-joy/nav" }
  }
}

provider "nav" {}   # reads NAV_HOST, NAV_TOKEN and NAV_WORKSPACE
```

```sh
export NAV_HOST=http://localhost:4000
export NAV_TOKEN=nav_xxxxxxxx
export NAV_WORKSPACE=ws_xxxxxxxx
```

## Semantics worth knowing

- `type` of a service, the database version/name/user, environments and custom domains cannot be changed by the API;
  changing them replaces the resource. Shrinking a Postgres disk also replaces it.
- `env_vars`, `secret_files` and `env_group_ids` (services) and `env_vars` / `secret_files` (env groups) are managed as
  complete sets when present and left alone when omitted. Removing them after they were set clears them.
- While a service autoscales, `instance_count` drift is ignored and not sent to the API.
- Postgres and Key Value creation waits until the instance is available (`wait_for_available`, 15 minute limit) so the
  sensitive connection strings can be wired into services in the same apply.
- Write-only secrets (registry password, log stream token) cannot be read back, so outside changes to them are not
  detected; a removed log stream token is.
- Everything returning `404` on refresh is dropped from state and recreated on the next apply.

## Tests

Unit tests (API client against an `httptest` server, schema validation) need no NAV instance:

```sh
go test ./...
```

Acceptance tests create real resources and only run with `TF_ACC=1`:

```sh
TF_ACC=1 NAV_HOST=http://localhost:4000 NAV_TOKEN=nav_... NAV_WORKSPACE=ws_... \
  NAV_ACC_REPO=https://github.com/acme/hello-node \
  go test ./internal/provider -run TestAcc -v -timeout 30m
```

Use a disposable workspace: the tests create and delete projects, env groups, webhooks, registry credentials and a service.

## Layout

```
main.go                     provider server entry point
internal/client/            typed API client (retries on 429/5xx) + unit tests
internal/provider/          provider, resources, data sources, acceptance tests
docs/                       registry-style docs
examples/full-stack/        end-to-end example
```
