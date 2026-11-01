---
page_title: "nav_custom_domain Resource - NAV"
description: |-
  A custom domain on a web service or static site.
---

# nav_custom_domain (Resource)

Point a DNS record of type `dns_record_type` at `dns_target`; NAV verifies DNS in the background and issues a TLS
certificate. Adding an apex domain (`example.com`) also adds a `www.` redirect that is removed with it.
Requires admin access.

## Example Usage

```terraform
resource "nav_custom_domain" "app" {
  service_id = nav_service.web.id
  domain     = "app.example.com"
}

output "dns" {
  value = "${nav_custom_domain.app.domain} ${nav_custom_domain.app.dns_record_type} ${nav_custom_domain.app.dns_target}"
}
```

## Schema

### Required

- `service_id` (String) **Forces replacement.**
- `domain` (String) Lower case, no trailing dot; wildcards like `*.example.com` are allowed. **Forces replacement.**

### Read-Only

- `id`, `redirect_to`, `verification_status` (`unverified`/`verified`/`failed`), `cert_status`
  (`pending`/`issuing`/`issued`/`failed`), `dns_target`, `dns_record_type` (`CNAME`/`A`), `verified_at`

## Import

The API lists domains per service, so the import ID includes the service:

```shell
terraform import nav_custom_domain.app srv_abc123/cdm_def456
```
