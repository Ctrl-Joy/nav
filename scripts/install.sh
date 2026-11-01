#!/usr/bin/env bash
# NAV one-command installer for Ubuntu 22.04 / 24.04 (x86_64 and arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/Ctrl-Joy/nav/landing-auth-dashboard-redesign/scripts/install.sh \
#     | sudo bash -s -- --domain onnav.duckdns.org --email you@example.com --duckdns-token TOKEN
#
# or from a clone:  sudo bash scripts/install.sh --domain ... --email ...
#
# Installs Node 24, git, Docker Engine and PostgreSQL 17 (PGDG), creates the `nav` system user, deploys the repo
# to /opt/nav, builds the dashboard, writes /etc/nav/*.env, installs the nav-control / nav-agent / nav-edge
# systemd units, opens 80/443 and starts everything. Safe to run again: secrets are generated once and kept,
# the configuration is rewritten from the flags (falling back to the previous values).
#
# Hostnames: apps are https://<service>.<domain>; the dashboard and API are https://dashboard.<domain> (the edge
# routes that host to the control plane, which only listens on 127.0.0.1). The bare <domain> redirects there.
#
#   --upgrade               git pull, npm ci, build, migrate, restart
#   --uninstall [--purge]   stop and remove the units; --purge also deletes /opt/nav, /var/lib/nav, /etc/nav,
#                           the nav database and role, and the nav user
set -Eeuo pipefail

main() {
  readonly NAV_HOME=/opt/nav
  readonly NAV_DATA=/var/lib/nav
  readonly NAV_ETC=/etc/nav
  readonly SECRETS_ENV=$NAV_ETC/nav.env
  readonly CONFIG_ENV=$NAV_ETC/config.env
  readonly OVERRIDE_ENV=$NAV_ETC/override.env
  readonly NAV_USER=nav
  readonly PG_VERSION=17
  readonly API_PORT=4000
  readonly ACME_STAGING=https://acme-staging-v02.api.letsencrypt.org/directory
  readonly ACME_PRODUCTION=https://acme-v02.api.letsencrypt.org/directory
  readonly DEFAULT_REPO=https://github.com/Ctrl-Joy/nav.git
  readonly DEFAULT_BRANCH=landing-auth-dashboard-redesign
  readonly UNITS=(nav-control nav-agent nav-edge)
  export DEBIAN_FRONTEND=noninteractive GIT_TERMINAL_PROMPT=0

  local mode=install domain='' email='' admin_email='' duckdns_token='' cloudflare_token='' repo='' branch=''
  local certs='' public_ip='' purge=0 skip_firewall=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) need_value "$@"; domain=$2; shift ;;
      --email) need_value "$@"; email=$2; shift ;;
      --admin-email) need_value "$@"; admin_email=$2; shift ;;
      --duckdns-token) need_value "$@"; duckdns_token=$2; shift ;;
      --cloudflare-token) need_value "$@"; cloudflare_token=$2; shift ;;
      --repo) need_value "$@"; repo=$2; shift ;;
      --branch) need_value "$@"; branch=$2; shift ;;
      --public-ip) need_value "$@"; public_ip=$2; shift ;;
      --production-certs) certs=production ;;
      --staging-certs) certs=staging ;;
      --skip-firewall) skip_firewall=1 ;;
      --upgrade) mode=upgrade ;;
      --uninstall) mode=uninstall ;;
      --purge) purge=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  [[ $EUID -eq 0 ]] || die "run as root (sudo bash install.sh ...)"
  [[ $purge -eq 0 || $mode == uninstall ]] || die "--purge only goes with --uninstall"
  # Resolve the clone this script may run from before leaving the caller's directory (which `nav` may not be able to read).
  local local_clone
  local_clone=$(script_clone)
  cd /

  case "$mode" in
    uninstall) uninstall "$purge"; return ;;
    upgrade)
      [[ -f $CONFIG_ENV ]] || die "NAV is not installed here ($CONFIG_ENV missing); run the installer without --upgrade first"
      check_os
      repo=$(prev NAV_INSTALL_REPO); branch=$(prev NAV_INSTALL_BRANCH)
      deploy_code "${repo:-$DEFAULT_REPO}" "${branch:-$DEFAULT_BRANCH}"
      write_units
      run_migrations
      restart_units
      wait_healthy "$(prev NAV_DASHBOARD_HOST)"
      log "upgrade complete: $(git_as_nav -C "$NAV_HOME" log -1 --format='%h %s')"
      return
      ;;
  esac

  check_os

  # Previous values are the defaults, so `install.sh --production-certs` alone switches an existing install.
  domain=$(lower "${domain:-$(prev NAV_APPS_DOMAIN)}")
  email=${email:-$(prev NAV_ACME_EMAIL)}
  admin_email=${admin_email:-$(prev NAV_ADMIN_EMAILS)}
  admin_email=${admin_email:-$email}
  repo=${repo:-$(prev NAV_INSTALL_REPO)}
  branch=${branch:-$(prev NAV_INSTALL_BRANCH)}
  if [[ -n $local_clone ]]; then
    repo=${repo:-$(git -c safe.directory="$local_clone" -C "$local_clone" remote get-url origin 2>/dev/null || true)}
    branch=${branch:-$(git -c safe.directory="$local_clone" -C "$local_clone" rev-parse --abbrev-ref HEAD 2>/dev/null || true)}
    [[ $branch != HEAD ]] || branch=''
  fi
  repo=${repo:-$DEFAULT_REPO}
  branch=${branch:-$DEFAULT_BRANCH}

  local dns_provider='' dns_token_var='' dns_token=''
  if [[ -n $duckdns_token && -n $cloudflare_token ]]; then die "pass either --duckdns-token or --cloudflare-token, not both"; fi
  if [[ -n $duckdns_token ]]; then dns_provider=duckdns; dns_token=$duckdns_token
  elif [[ -n $cloudflare_token ]]; then dns_provider=cloudflare; dns_token=$cloudflare_token
  else
    dns_provider=$(prev NAV_DNS_PROVIDER)
    case "$dns_provider" in
      duckdns) dns_token=$(prev NAV_DUCKDNS_TOKEN) ;;
      cloudflare) dns_token=$(prev NAV_CLOUDFLARE_API_TOKEN) ;;
    esac
  fi
  case "$dns_provider" in
    duckdns) dns_token_var=NAV_DUCKDNS_TOKEN ;;
    cloudflare) dns_token_var=NAV_CLOUDFLARE_API_TOKEN ;;
  esac

  local acme_dir
  case "$certs" in
    production) acme_dir=$ACME_PRODUCTION ;;
    staging) acme_dir=$ACME_STAGING ;;
    *) acme_dir=$(prev NAV_ACME_DIRECTORY); acme_dir=${acme_dir:-$ACME_STAGING} ;;
  esac

  [[ -n $domain ]] || die "--domain is required (e.g. --domain onnav.duckdns.org)"
  [[ -n $email ]] || die "--email is required (Let's Encrypt account and default admin)"
  [[ $domain =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "invalid --domain: $domain"
  valid_email "$email" || die "invalid --email: $email"
  local e admin_list
  IFS=',' read -r -a admin_list <<<"$admin_email"
  for e in "${admin_list[@]}"; do valid_email "$e" || die "invalid --admin-email: $e"; done
  [[ -z $dns_token || $dns_token =~ ^[A-Za-z0-9_-]+$ ]] || die "the DNS token contains unexpected characters"
  [[ $repo =~ ^[A-Za-z0-9@:/._~+%-]+$ ]] || die "invalid --repo: $repo"
  [[ $branch =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --branch: $branch"
  if [[ $domain == *.duckdns.org ]]; then
    [[ $dns_provider == duckdns ]] || die "$domain is a DuckDNS name: pass --duckdns-token (from duckdns.org) so NAV can issue the wildcard certificate"
    [[ $dns_provider != duckdns || $domain =~ ^[a-z0-9-]+\.duckdns\.org$ ]] || warn "with DuckDNS, use the subdomain itself as --domain (<sub>.duckdns.org)"
  fi
  [[ -n $dns_provider ]] || warn "no --duckdns-token / --cloudflare-token: no wildcard certificate will be issued (the edge serves a self-signed one)"

  local dashboard_host="dashboard.$domain"

  log "NAV install: domain $domain, dashboard https://$dashboard_host, repo $repo ($branch), certificates from $(acme_label "$acme_dir")"
  install_packages
  install_node
  install_docker
  install_postgres
  create_user
  ensure_secrets
  local pg_port
  pg_port=$(pg_cluster_port)
  setup_database "$pg_port"

  [[ -n $public_ip ]] || public_ip=$(detect_public_ip)
  [[ $public_ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "could not detect the public IPv4 address; pass --public-ip"
  log "public IP: $public_ip"
  if [[ $dns_provider == duckdns ]]; then duckdns_point_a "$domain" "$dns_token" "$public_ip"; fi

  deploy_code "$repo" "$branch"
  write_config "$domain" "$dashboard_host" "$email" "$admin_email" "$acme_dir" "$dns_provider" "$dns_token_var" "$dns_token" "$public_ip" "$pg_port" "$repo" "$branch"
  write_units
  check_ports_free
  if [[ $skip_firewall -eq 0 ]]; then open_firewall; else warn "--skip-firewall: make sure TCP 80 and 443 are reachable"; fi
  run_migrations
  restart_units
  wait_healthy "$dashboard_host"
  check_dns "$dashboard_host" "$public_ip"
  summary "$domain" "$dashboard_host" "$admin_email" "$acme_dir" "$dns_provider"
}

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh --domain <domain> --email <you@example.com> [options]

  --domain D             apps domain: services are <name>.D, the dashboard is dashboard.D
  --email E              Let's Encrypt account email (also the default admin)
  --duckdns-token T      DuckDNS token: issue the wildcard certificate via DuckDNS (D must be <sub>.duckdns.org)
  --cloudflare-token T   Cloudflare API token with Zone:DNS:Edit: issue the wildcard certificate via Cloudflare
  --admin-email E[,E2]   platform admins (default: --email); sign up with this address
  --repo URL             git repository (default: the clone this script runs from, else https://github.com/Ctrl-Joy/nav.git)
  --branch B             branch (default: landing-auth-dashboard-redesign)
  --public-ip IP         public IPv4 of this server (default: detected)
  --production-certs     use the Let's Encrypt production directory (default: staging, untrusted by browsers)
  --staging-certs        switch back to the staging directory
  --skip-firewall        do not touch ufw / iptables
  --upgrade              pull the latest code, npm ci, build, migrate and restart
  --uninstall [--purge]  stop and remove the services; --purge also deletes code, data, config and the database

Re-running keeps generated secrets (/etc/nav/nav.env) and reuses previous values for omitted flags.
Put extra settings (GitHub App, SMTP...) in /etc/nav/override.env; the installer never touches it.
EOF
}

# --- helpers -----------------------------------------------------------------------------------------

if [[ -t 1 ]]; then C_BLUE=$'\033[1;34m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_OFF=$'\033[0m'
else C_BLUE=''; C_YELLOW=''; C_RED=''; C_GREEN=''; C_OFF=''; fi

log() { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok() { printf '%s ok%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
on_error() { printf '%serror:%s command failed (exit %s) at line %s: %s\n' "$C_RED" "$C_OFF" "$1" "$2" "$3" >&2; }
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

need_value() { [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 needs a value"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
valid_email() { [[ $1 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
acme_label() { if [[ $1 == "$ACME_PRODUCTION" ]]; then echo "Let's Encrypt (production)"; else echo "Let's Encrypt STAGING"; fi; }

# A previous value from the generated configuration (read, never sourced).
prev() { [[ -f $CONFIG_ENV ]] || return 0; sed -n "s/^$1=//p" "$CONFIG_ENV" | tail -n 1; }

# The clone this script runs from, if any (empty when piped from curl).
script_clone() {
  local src=${BASH_SOURCE[0]:-} dir
  [[ -n $src && -f $src ]] || return 0
  dir=$(cd "$(dirname "$src")/.." && pwd)
  if [[ -e $dir/.git && -f $dir/apps/control/package.json ]]; then echo "$dir"; fi
}

apt_install() { apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends "$@" </dev/null; }
apt_update() { apt-get -o DPkg::Lock::Timeout=600 update -q </dev/null; }

as_nav() { runuser -u "$NAV_USER" -- "$@"; }
git_as_nav() { as_nav git "$@"; }

os_field() { sed -n "s/^$1=//p" /etc/os-release | tr -d '"'; }

check_os() {
  [[ -r /etc/os-release ]] || die "cannot read /etc/os-release"
  local id version codename
  id=$(os_field ID)
  version=$(os_field VERSION_ID)
  codename=$(os_field VERSION_CODENAME)
  [[ $id == ubuntu ]] || die "this installer supports Ubuntu 22.04 and 24.04 (found $id $version)"
  case "$version" in 22.04 | 24.04) ;; *) warn "untested Ubuntu $version; continuing" ;; esac
  case "$(uname -m)" in x86_64 | aarch64) ;; *) die "unsupported architecture $(uname -m) (x86_64 or arm64 only)" ;; esac
  UBUNTU_CODENAME=$codename
}

# --- packages ----------------------------------------------------------------------------------------

install_packages() {
  log "installing base packages"
  apt_update
  apt_install ca-certificates curl gnupg git openssl iproute2 iptables
  install -m 0755 -d /etc/apt/keyrings
}

install_node() {
  local major=0
  if command -v node >/dev/null; then major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
  if [[ $major -ge 24 ]]; then ok "Node $(node -v) already installed"; return; fi
  log "installing Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt_update
  apt_install nodejs
  ok "Node $(node -v)"
}

install_docker() {
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) already installed"; return; fi
  if ! command -v docker >/dev/null; then
    log "installing Docker Engine (download.docker.com apt repository)"
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $UBUNTU_CODENAME stable" >/etc/apt/sources.list.d/docker.list
    apt_update
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  fi
  systemctl enable --now docker >/dev/null
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (systemctl status docker)"
  ok "Docker $(docker version --format '{{.Server.Version}}')"
}

install_postgres() {
  if ! dpkg -s "postgresql-$PG_VERSION" >/dev/null 2>&1; then
    log "installing PostgreSQL $PG_VERSION (apt.postgresql.org)"
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /etc/apt/keyrings/postgresql.asc
    chmod a+r /etc/apt/keyrings/postgresql.asc
    echo "deb [signed-by=/etc/apt/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt $UBUNTU_CODENAME-pgdg main" >/etc/apt/sources.list.d/pgdg.list
    apt_update
    apt_install "postgresql-$PG_VERSION"
  fi
  if ! pg_lsclusters -h | awk -v v="$PG_VERSION" '$1 == v && $2 == "main" { found = 1 } END { exit !found }'; then
    pg_createcluster "$PG_VERSION" main >/dev/null
  fi
  systemctl enable postgresql >/dev/null 2>&1 || true
  systemctl start "postgresql@$PG_VERSION-main"
  ok "PostgreSQL $PG_VERSION (cluster main, port $(pg_cluster_port))"
}

pg_cluster_port() { pg_lsclusters -h | awk -v v="$PG_VERSION" '$1 == v && $2 == "main" { print $3 }'; }

psql_admin() { (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$1" -d postgres "${@:2}" </dev/null); }

# --- user, secrets, database ------------------------------------------------------------------------

create_user() {
  if ! id -u "$NAV_USER" >/dev/null 2>&1; then
    log "creating system user $NAV_USER"
    useradd --system --home-dir "$NAV_DATA" --create-home --shell /usr/sbin/nologin "$NAV_USER"
  fi
  usermod -aG docker "$NAV_USER"
  install -d -m 0750 -o "$NAV_USER" -g "$NAV_USER" "$NAV_DATA"
  install -d -m 0755 -o "$NAV_USER" -g "$NAV_USER" "$NAV_HOME"
  install -d -m 0750 -o root -g "$NAV_USER" "$NAV_ETC"
}

# Generated once; an existing value is never changed (losing NAV_MASTER_KEY makes encrypted data unreadable).
ensure_secrets() {
  umask 077
  [[ -f $SECRETS_ENV ]] || printf '# NAV secrets, generated by install.sh. Back this file up; never edit NAV_MASTER_KEY.\n' >"$SECRETS_ENV"
  if ! grep -q '^NAV_MASTER_KEY=' "$SECRETS_ENV"; then
    echo "NAV_MASTER_KEY=$(openssl rand -hex 32)" >>"$SECRETS_ENV"
    log "generated NAV_MASTER_KEY in $SECRETS_ENV (back it up)"
  fi
  if ! grep -q '^NAV_PG_PASSWORD=' "$SECRETS_ENV"; then echo "NAV_PG_PASSWORD=$(openssl rand -hex 24)" >>"$SECRETS_ENV"; fi
  chown root:root "$SECRETS_ENV"
  chmod 0600 "$SECRETS_ENV"
  umask 022
}

secret() { sed -n "s/^$1=//p" "$SECRETS_ENV" | tail -n 1; }

setup_database() {
  local port=$1 password
  password=$(secret NAV_PG_PASSWORD)
  [[ $password =~ ^[0-9a-f]+$ ]] || die "unexpected NAV_PG_PASSWORD format in $SECRETS_ENV"
  local tries=0
  until psql_admin "$port" -c 'SELECT 1' >/dev/null 2>&1; do
    tries=$((tries + 1)); [[ $tries -lt 30 ]] || die "PostgreSQL on port $port is not accepting connections"
    sleep 1
  done
  log "configuring the nav database"
  if [[ $(psql_admin "$port" -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'nav'") == 1 ]]; then
    psql_admin "$port" -c "ALTER ROLE nav WITH LOGIN PASSWORD '$password'" >/dev/null
  else
    psql_admin "$port" -c "CREATE ROLE nav WITH LOGIN PASSWORD '$password'" >/dev/null
  fi
  if [[ $(psql_admin "$port" -tAc "SELECT 1 FROM pg_database WHERE datname = 'nav'") != 1 ]]; then
    psql_admin "$port" -c 'CREATE DATABASE nav OWNER nav' >/dev/null
  fi
  ok "database nav on 127.0.0.1:$port"
}

# --- code --------------------------------------------------------------------------------------------

deploy_code() {
  local repo=$1 branch=$2
  if [[ -d $NAV_HOME/.git ]]; then
    log "updating $NAV_HOME ($branch)"
    git_as_nav -C "$NAV_HOME" remote set-url origin "$repo"
    git_as_nav -C "$NAV_HOME" fetch --prune origin "$branch"
    if [[ $(git_as_nav -C "$NAV_HOME" rev-parse --abbrev-ref HEAD) != "$branch" ]]; then
      git_as_nav -C "$NAV_HOME" checkout -B "$branch" "origin/$branch"
    fi
    git_as_nav -C "$NAV_HOME" pull --ff-only origin "$branch" || die "cannot fast-forward $NAV_HOME (local changes?). Inspect it with: sudo -u nav git -C $NAV_HOME status"
  else
    [[ -z $(ls -A "$NAV_HOME" 2>/dev/null) ]] || die "$NAV_HOME exists and is not a git checkout; move it away first"
    log "cloning $repo ($branch) into $NAV_HOME"
    git_as_nav clone --branch "$branch" "$repo" "$NAV_HOME" </dev/null
  fi
  log "installing dependencies (npm ci)"
  (cd "$NAV_HOME" && as_nav env -u NODE_ENV HOME="$NAV_DATA" npm ci --include=dev --no-audit --no-fund --loglevel=error </dev/null)
  log "building the dashboard"
  (cd "$NAV_HOME" && as_nav env -u NODE_ENV HOME="$NAV_DATA" npm run build -w @nav/web --silent </dev/null)
  [[ -f $NAV_HOME/apps/web/dist/index.html ]] || die "dashboard build produced no apps/web/dist/index.html"
  ok "code at $(git_as_nav -C "$NAV_HOME" log -1 --format='%h %s')"
}

# --- configuration -----------------------------------------------------------------------------------

write_config() {
  local domain=$1 dashboard_host=$2 email=$3 admins=$4 acme_dir=$5 dns_provider=$6 dns_token_var=$7 dns_token=$8 public_ip=$9
  local pg_port=${10} repo=${11} branch=${12} password force_https=0
  password=$(secret NAV_PG_PASSWORD)
  [[ $acme_dir != "$ACME_PRODUCTION" ]] || force_https=1
  local tmp
  tmp=$(mktemp "$NAV_ETC/.config.XXXXXX")
  {
    echo "# Generated by scripts/install.sh; rewritten on every install. Put your own settings in $OVERRIDE_ENV."
    echo "NODE_ENV=production"
    echo "NAV_DATA_DIR=$NAV_DATA"
    echo "NAV_DATABASE_URL=postgres://nav:$password@127.0.0.1:$pg_port/nav"
    echo "NAV_DRIVER=docker"
    echo "NAV_API_PORT=$API_PORT"
    echo "NAV_CONTROL_URL=http://127.0.0.1:$API_PORT"
    echo "NAV_TRUST_PROXY=loopback"
    echo "NAV_APPS_DOMAIN=$domain"
    echo "NAV_DASHBOARD_HOST=$dashboard_host"
    echo "NAV_DASHBOARD_URL=https://$dashboard_host"
    echo "NAV_API_PUBLIC_URL=https://$dashboard_host"
    echo "NAV_PUBLIC_SCHEME=https"
    echo "NAV_PUBLIC_PORT_SUFFIX="
    echo "NAV_EDGE_HTTP_PORT=80"
    echo "NAV_EDGE_HTTPS_PORT=443"
    echo "NAV_EDGE_PUBLIC_IP=$public_ip"
    echo "NAV_EDGE_FORCE_HTTPS=$force_https"
    echo "NAV_ACME_EMAIL=$email"
    echo "NAV_ACME_DIRECTORY=$acme_dir"
    echo "NAV_ADMIN_EMAILS=$admins"
    if [[ -n $dns_provider ]]; then
      echo "NAV_DNS_PROVIDER=$dns_provider"
      echo "$dns_token_var=$dns_token"
    fi
    echo "NAV_INSTALL_REPO=$repo"
    echo "NAV_INSTALL_BRANCH=$branch"
  } >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$CONFIG_ENV"
  if [[ ! -f $OVERRIDE_ENV ]]; then
    printf '# Your own NAV settings (GitHub App, SMTP, ...). Loaded last; install.sh never changes this file.\n' >"$OVERRIDE_ENV"
    chmod 0600 "$OVERRIDE_ENV"
  fi
  ok "configuration in $CONFIG_ENV"
}

write_unit() {
  local name=$1 description=$2 exec=$3 extra=$4
  cat >"/etc/systemd/system/$name.service" <<EOF
[Unit]
Description=$description
After=network-online.target docker.service postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=$NAV_USER
Group=$NAV_USER
WorkingDirectory=$NAV_HOME
EnvironmentFile=$SECRETS_ENV
EnvironmentFile=$CONFIG_ENV
EnvironmentFile=-$OVERRIDE_ENV
ExecStart=$(command -v node) $exec
Restart=always
RestartSec=3
LimitNOFILE=65536
$extra

[Install]
WantedBy=multi-user.target
EOF
}

write_units() {
  log "installing systemd units"
  write_unit nav-control "NAV control plane (API, dashboard, scheduler)" apps/control/src/main.ts \
    "NoNewPrivileges=true"
  # The agent drives Docker through its socket: the docker group is root-equivalent, which is why apps run in containers.
  write_unit nav-agent "NAV node agent (builds and runs instances)" apps/control/src/agent/main.ts \
    "SupplementaryGroups=docker
KillMode=mixed
TimeoutStopSec=30"
  write_unit nav-edge "NAV edge (public HTTP/HTTPS ingress on 80/443)" apps/edge/src/main.ts \
    "AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true"
  systemctl daemon-reload
  systemctl enable "${UNITS[@]}" >/dev/null 2>&1
}

check_ports_free() {
  local port pids
  for port in 80 443; do
    pids=$(ss -Hltnp "sport = :$port" 2>/dev/null || true)
    [[ -z $pids ]] && continue
    if systemctl is-active --quiet nav-edge && grep -q '"node"' <<<"$pids"; then continue; fi
    die "port $port is already in use: $pids
Stop that service (for example: systemctl disable --now nginx apache2 caddy) and run the installer again."
  done
}

# --- firewall ----------------------------------------------------------------------------------------

open_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    log "ufw is active: allowing 80/tcp and 443/tcp"
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
  fi
  # Oracle Cloud Ubuntu images ship iptables rules ending in a REJECT that blocks everything but SSH.
  local reject_line port
  reject_line=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
  if [[ -n $reject_line ]]; then
    for port in 443 80; do
      if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null; then
        iptables -I INPUT "$reject_line" -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
        log "iptables: accepted TCP $port (inserted before the REJECT rule)"
      fi
    done
    persist_iptables
  fi
  ok "firewall: TCP 80 and 443 open on this host (also open them in your cloud provider's security list)"
}

# Edits the saved INPUT rules in place rather than running `netfilter-persistent save`, which would also
# freeze Docker's own chains into the boot-time rules.
persist_iptables() {
  local rules=/etc/iptables/rules.v4 port
  if [[ ! -f $rules ]]; then
    warn "no $rules: the iptables rules for 80/443 will not survive a reboot (install iptables-persistent, or re-run this installer after reboots)"
    return
  fi
  grep -q '^-A INPUT .*-j REJECT' "$rules" || return 0
  for port in 80 443; do
    grep -Eq -- "^-A INPUT .*--dport $port .*-j ACCEPT" "$rules" && continue
    cp -p "$rules" "$rules.nav-backup"
    awk -v rule="-A INPUT -p tcp -m state --state NEW -m tcp --dport $port -j ACCEPT" '
      !done && /^-A INPUT .*-j REJECT/ { print rule; done = 1 }
      { print }' "$rules.nav-backup" >"$rules"
    log "persisted the TCP $port rule in $rules"
  done
}

# --- services ----------------------------------------------------------------------------------------

run_migrations() {
  log "applying database migrations"
  local db_url
  db_url=$(prev NAV_DATABASE_URL)
  [[ -n $db_url ]] || die "NAV_DATABASE_URL missing from $CONFIG_ENV"
  (cd "$NAV_HOME/apps/control" && as_nav env NAV_DATABASE_URL="$db_url" NAV_DATA_DIR="$NAV_DATA" node src/db/migrate.ts </dev/null)
}

restart_units() {
  log "restarting ${UNITS[*]}"
  systemctl restart nav-control
  systemctl restart nav-agent nav-edge
}

wait_http() {
  local url=$1 host=$2 seconds=$3 i
  local args=(-fsS -o /dev/null --max-time 3)
  if [[ -n $host ]]; then args+=(-H "Host: $host"); fi
  for ((i = 0; i < seconds; i++)); do
    if curl "${args[@]}" "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

wait_healthy() {
  local dashboard_host=$1 unit
  log "waiting for the control plane"
  if ! wait_http "http://127.0.0.1:$API_PORT/healthz" '' 120; then
    journalctl -u nav-control -n 40 --no-pager >&2 || true
    die "control plane did not become healthy (journalctl -u nav-control)"
  fi
  ok "control plane healthy"
  if ! wait_http "http://127.0.0.1/__nav/health" '' 60; then
    journalctl -u nav-edge -n 40 --no-pager >&2 || true
    die "edge did not start on port 80 (journalctl -u nav-edge)"
  fi
  if [[ -n $dashboard_host ]] && ! wait_http "http://127.0.0.1/healthz" "$dashboard_host" 30; then
    warn "the edge does not route $dashboard_host to the control plane yet (journalctl -u nav-edge)"
  fi
  ok "edge healthy"
  for unit in "${UNITS[@]}"; do
    systemctl is-active --quiet "$unit" || die "$unit is not running (journalctl -u $unit)"
  done
}

# --- network -----------------------------------------------------------------------------------------

detect_public_ip() {
  local url ip
  for url in https://api.ipify.org https://checkip.amazonaws.com https://ifconfig.me/ip; do
    ip=$(curl -4 -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then echo "$ip"; return; fi
  done
}

# Points <sub>.duckdns.org (and so every name below it) at this server. The token stays off the command line.
duckdns_point_a() {
  local domain=$1 token=$2 ip=$3 sub answer
  [[ $domain == *.duckdns.org ]] || return 0
  sub=${domain%.duckdns.org}
  sub=${sub##*.}
  answer=$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=%s"\n' "$sub" "$token" "$ip" | curl -fsS --max-time 20 -K - 2>/dev/null || true)
  if [[ $answer == OK* ]]; then ok "DuckDNS: $sub.duckdns.org -> $ip"
  else warn "DuckDNS did not accept the update for $sub.duckdns.org (answer: ${answer:-none}); check the token and set the IP on duckdns.org"; fi
}

check_dns() {
  local host=$1 ip=$2 resolved
  resolved=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
  if [[ $resolved == "$ip" ]]; then ok "$host resolves to $ip"
  else warn "$host resolves to '${resolved:-nothing}', not $ip: point the domain (and its wildcard *.) at this server"; fi
}

summary() {
  local domain=$1 dashboard_host=$2 admins=$3 acme_dir=$4 dns_provider=$5
  cat <<EOF

${C_GREEN}NAV is running.${C_OFF}

  Dashboard + API   https://$dashboard_host   (http:// works too until a trusted certificate is issued)
  Your apps         https://<service>.$domain
  Admin             sign up at https://$dashboard_host/signup with ${admins%%,*}

EOF
  if [[ -n $dns_provider ]]; then
    if [[ $acme_dir == "$ACME_PRODUCTION" ]]; then
      echo "  Certificates      Let's Encrypt production via $dns_provider; HTTP redirects to HTTPS once issued."
    else
      cat <<EOF
  Certificates      Let's Encrypt STAGING via $dns_provider (browsers will warn). Watch for the wildcard:
                      journalctl -u nav-control -f | grep '\[tls\]'
                    Once it logs "issued wildcard certificate", switch to trusted certificates:
                      sudo bash $NAV_HOME/scripts/install.sh --production-certs
EOF
    fi
    if [[ $dns_provider == duckdns ]]; then
      echo "                    DuckDNS: the certificate covers *.$domain only, not $domain itself (it redirects to the dashboard)."
    fi
  else
    echo "  Certificates      none (no DNS token): the edge serves a self-signed certificate."
  fi
  cat <<EOF

  Logs              journalctl -u nav-control -u nav-agent -u nav-edge -f
  Upgrade           sudo bash $NAV_HOME/scripts/install.sh --upgrade
  Settings          $CONFIG_ENV (generated), $OVERRIDE_ENV (yours), $SECRETS_ENV (back it up)
EOF
}

# --- uninstall ---------------------------------------------------------------------------------------

uninstall() {
  local purge=$1 unit port
  log "stopping and removing NAV services"
  for unit in "${UNITS[@]}"; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit.service"
  done
  systemctl daemon-reload
  if [[ $purge -ne 1 ]]; then
    ok "services removed. Kept: $NAV_HOME, $NAV_DATA, $NAV_ETC, the nav database and Docker containers (use --uninstall --purge to delete them)"
    return
  fi
  warn "purging NAV code, data, configuration and the platform database"
  if command -v docker >/dev/null; then
    docker ps -aq --filter label=nav.service | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker ps -aq --filter label=nav.instance | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  if command -v pg_lsclusters >/dev/null; then
    port=$(pg_cluster_port || true)
    if [[ -n $port ]]; then
      psql_admin "$port" -c 'DROP DATABASE IF EXISTS nav' >/dev/null 2>&1 || warn "could not drop database nav"
      psql_admin "$port" -c 'DROP ROLE IF EXISTS nav' >/dev/null 2>&1 || warn "could not drop role nav"
    fi
  fi
  rm -rf "$NAV_HOME" "$NAV_DATA" "$NAV_ETC"
  if id -u "$NAV_USER" >/dev/null 2>&1; then userdel "$NAV_USER" >/dev/null 2>&1 || warn "could not remove user $NAV_USER"; fi
  ok "NAV purged (Node, Docker and PostgreSQL packages and the firewall rules were left in place)"
}

main "$@"
