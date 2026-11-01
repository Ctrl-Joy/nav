output "workspace" {
  value = data.nav_workspace.current.name
}

output "web_url" {
  value = nav_service.web.url
}

output "dns_record" {
  description = "Create this record at your DNS provider."
  value       = "${nav_custom_domain.www.domain} ${nav_custom_domain.www.dns_record_type} ${nav_custom_domain.www.dns_target}"
}

output "database_url" {
  value     = nav_postgres.db.external_connection_string
  sensitive = true
}
