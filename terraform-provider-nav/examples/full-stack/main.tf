# A full NAV stack: a web service and a background worker sharing an env
# group, backed by PostgreSQL and Key Value, with a custom domain.
#
#   export NAV_HOST=http://localhost:4000 NAV_TOKEN=nav_... NAV_WORKSPACE=ws_...
#   terraform init && terraform apply -var repo_url=https://github.com/acme/shop

terraform {
  required_providers {
    nav = {
      source = "ctrl-joy/nav"
    }
  }
}

provider "nav" {
  # host, api_key and workspace_id default to NAV_HOST, NAV_TOKEN and NAV_WORKSPACE.
}

data "nav_workspace" "current" {}

resource "nav_project" "shop" {
  name                 = "shop"
  initial_environments = ["production", "staging"]
}

locals {
  production = nav_project.shop.environment_ids["production"]
}

resource "nav_postgres" "db" {
  name           = "shop-db"
  plan           = "basic-1gb"
  pg_version     = 17
  disk_gb        = 10
  environment_id = local.production
}

resource "nav_key_value" "cache" {
  name             = "shop-cache"
  plan             = "starter"
  maxmemory_policy = "allkeys-lru"
  environment_id   = local.production
}

resource "nav_env_group" "shared" {
  name = "shop-shared"
  env_vars = {
    DATABASE_URL = nav_postgres.db.internal_connection_string
    REDIS_URL    = nav_key_value.cache.internal_connection_string
    LOG_LEVEL    = "info"
  }
}

resource "nav_service" "web" {
  name               = "shop-web"
  type               = "web"
  environment_id     = local.production
  repo_url           = var.repo_url
  branch             = var.branch
  runtime            = "node"
  build_command      = "npm ci && npm run build"
  start_command      = "npm start"
  pre_deploy_command = "npm run migrate"
  health_check_path  = "/healthz"
  plan               = "standard"
  auto_deploy        = "commit"

  autoscaling = {
    min                = 2
    max                = 6
    target_cpu_percent = 70
  }

  env_vars = {
    SESSION_SECRET = var.session_secret
  }
  env_group_ids = [nav_env_group.shared.id]
}

resource "nav_service" "worker" {
  name           = "shop-worker"
  type           = "worker"
  environment_id = local.production
  repo_url       = var.repo_url
  branch         = var.branch
  runtime        = "node"
  build_command  = "npm ci"
  start_command  = "node worker.js"
  plan           = "starter"
  instance_count = 1
  env_group_ids  = [nav_env_group.shared.id]
}

resource "nav_custom_domain" "www" {
  service_id = nav_service.web.id
  domain     = var.domain
}
