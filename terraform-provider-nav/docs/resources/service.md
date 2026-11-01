---
page_title: "nav_service Resource - NAV"
description: |-
  A web service, private service, background worker, cron job or static site.
---

# nav_service (Resource)

A NAV service. Creating it queues the first deploy. Settings changes (`PATCH /services/:id`) apply on the next deploy;
changes to `env_vars`, `secret_files` and `env_group_ids` queue an `env_change` deploy (env vars and files only when
`deploy_on_env_change` is `true`). Custom domains are managed with [`nav_custom_domain`](custom_domain.md).

## Example Usage

```terraform
resource "nav_service" "api" {
  name              = "api"
  type              = "web"
  repo_url          = "https://github.com/acme/api"
  branch            = "main"
  root_dir          = "services/api"
  runtime           = "node"
  build_command     = "npm ci && npm run build"
  start_command     = "npm start"
  health_check_path = "/healthz"
  plan              = "standard"

  autoscaling = {
    min                = 2
    max                = 5
    target_cpu_percent = 70
  }

  env_vars      = { NODE_ENV = "production" }
  secret_files  = { "service-account.json" = file("sa.json") }
  env_group_ids = [nav_env_group.shared.id]
}

resource "nav_service" "nightly" {
  name          = "nightly-report"
  type          = "cron"
  repo_url      = "https://github.com/acme/api"
  start_command = "node report.js"
  cron_schedule = "0 3 * * *"
}

resource "nav_service" "image" {
  name                   = "proxy"
  type                   = "private"
  image_url              = "ghcr.io/acme/proxy:1.4.0"
  registry_credential_id = nav_registry_credential.ghcr.id
  port                   = 8080
  disk = {
    name       = "cache"
    mount_path = "/var/cache/proxy"
    size_gb    = 5
  }
}
```

## Schema

### Required

- `name` (String) 1-64 characters. Renaming keeps the slug and URL.
- `type` (String) `web`, `private`, `worker`, `cron` or `static`. **Forces replacement.**

### Optional

- `workspace_id` (String) Defaults to the provider's. **Forces replacement.**
- `environment_id` (String) Project environment.
- `runtime` (String) `auto`, `node`, `python`, `go`, `ruby`, `bun`, `docker`, `image`, `static`. Defaults to `image` with `image_url`, else `auto`.
- `repo_url` (String) HTTPS repository URL. Required unless `image_url` is set.
- `branch` (String) Defaults to the repository's default branch.
- `root_dir` (String) Relative directory inside the repository. Defaults to `""`.
- `image_url` (String) Prebuilt image to run.
- `registry_credential_id` (String) Credential for pulling `image_url`.
- `build_command`, `start_command`, `pre_deploy_command` (String) Non-empty when set.
- `dockerfile_path` (String) Defaults to `Dockerfile`. `docker_context` (String) Defaults to `.`.
- `publish_path` (String) Output directory of a static site.
- `health_check_path` (String) Web services only; must start with `/`.
- `port` (Number) 1-65535.
- `plan` (String) `free`, `starter`, `standard`, `pro`, `pro_plus`. Defaults to `starter` (`free` for static sites).
- `instance_count` (Number) 1-100, defaults to 1; always 1 for cron jobs. Ignored for drift while autoscaling is enabled.
- `autoscaling` (Attributes) `enabled` (Bool, default `true`), `min`, `max` (Number, required), `target_cpu_percent`, `target_memory_percent` (Number, 10-95). Removing the block disables autoscaling.
- `disk` (Attributes) `name`, `mount_path`, `size_gb` (all required). Limits the service to one instance.
- `auto_deploy` (String) `commit` (default), `checks` or `off`.
- `cron_schedule` (String) Required for, and only valid on, cron jobs.
- `env_vars` (Map of String, Sensitive) Full set of variables. Omit to leave variables unmanaged; removing the attribute after it was set clears them.
- `secret_files` (Map of String, Sensitive) File name to content. Same semantics as `env_vars`.
- `env_group_ids` (Set of String) Linked env groups. Same semantics as `env_vars`.
- `deploy_on_env_change` (Bool) Default `true`.

### Read-Only

- `id`, `slug`, `url`, `internal_address`, `status`
- `deploy_hook_url` (Sensitive)

## Import

```shell
terraform import nav_service.api srv_abc123
```

`env_vars`, `secret_files` and `env_group_ids` are not imported; add them to the configuration to adopt them.
