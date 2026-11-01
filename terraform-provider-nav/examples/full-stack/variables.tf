variable "repo_url" {
  description = "HTTPS URL of the application repository."
  type        = string
}

variable "branch" {
  description = "Branch to deploy."
  type        = string
  default     = "main"
}

variable "domain" {
  description = "Custom domain for the web service."
  type        = string
  default     = "shop.example.com"
}

variable "session_secret" {
  description = "Secret used to sign sessions."
  type        = string
  sensitive   = true
  default     = "change-me"
}
