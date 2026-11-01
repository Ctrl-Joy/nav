---
page_title: "nav_log_stream Resource - NAV"
description: |-
  Forwards logs to an external syslog or HTTPS endpoint.
---

# nav_log_stream (Resource)

Without `service_id` this is the workspace's default log stream; with it, an override for one service. There is at most
one of each, so two resources must not manage the same slot. Requires admin access.

## Example Usage

```terraform
resource "nav_log_stream" "default" {
  protocol = "syslog-tls"
  endpoint = "logs.example.com:6514"
  token    = var.log_token
}

resource "nav_log_stream" "web" {
  service_id = nav_service.web.id
  protocol   = "https"
  endpoint   = "https://ingest.example.com/v1/logs"
}
```

## Schema

### Required

- `protocol` (String) `syslog-tls`, `syslog-tcp` or `https`.
- `endpoint` (String) `host:port` for syslog, an `https://` URL otherwise.

### Optional

- `workspace_id` (String) **Forces replacement.**
- `service_id` (String) **Forces replacement.**
- `token` (String, Sensitive) Write-only; if it is removed outside Terraform the plan shows it being set again.
- `enabled` (Bool) Default `true`.

### Read-Only

- `id` (String)

## Import

```shell
terraform import nav_log_stream.default lgs_abc123
```
