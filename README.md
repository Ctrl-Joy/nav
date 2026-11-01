# NAV

A self-hostable platform-as-a-service: connect a Git repo and NAV builds it, runs it in isolated instances behind a
TLS-terminating load-balancing edge, and gives you logs, metrics, scaling, rollbacks, cron jobs, durable workflows, managed PostgreSQL,
custom domains, PR previews and infrastructure-as-code (`nav.yaml`).

| Part | Path | What it does |
|---|---|---|
| Control plane | `apps/control/src` | REST + SSE API, auth/RBAC, GitHub integration, scheduler (cron, autoscaler, reconciler, retention, backups) |
| Node agent | `apps/control/src/agent` | Builds, zero-downtime deploys, instance supervision, health checks, metrics, Postgres clusters |
| Edge | `apps/edge` | Reverse proxy, load balancer, SNI TLS, ACME, static site serving, HTTP metrics |
| Dashboard | `apps/web` | Landing page, onboarding, full management UI |
| CLI | `apps/cli` | `nav` command-line client |

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md)

## Run it locally

Requires Node 24+ and git. Docker is optional (without it the agent uses the process driver: real builds and
processes, but **no container isolation** — use Docker for untrusted code).

```bash
npm install
```

```bash
npm run dev
```

This boots an embedded PostgreSQL 17 for the platform (`.nav/platform-pg`, port 5433), generates a master key in
`.nav/platform.env`, applies migrations and starts control (`:4000`), agent, edge (`:7080` http / `:7443` https) and
the dashboard at **http://localhost:5180**. Apps are served at `http://<service>.nav.localhost:7080`.

To try deploys without GitHub, serve the bundled example apps over local Git smart-HTTP:

```bash
node scripts/git-serve.ts
```

Then create a service from `http://localhost:9420/node-web.git` (also `static-site`, `worker`, `cron-job`, `workflows` as a Workflow, and
`examples.git` with a `nav.yaml` blueprint).

## Tests

```bash
node scripts/e2e.ts
```

End-to-end against the running stack: Git build → live via edge, SSE logs, crash self-healing, scaling + round-robin,
zero-downtime env redeploy, rollback without rebuild, deploy hooks, suspend/resume, metrics, custom domain + TLS via SNI,
static sites (ETag/304/404), workers, cron (manual + scheduled + failure codes), Postgres provision/query/backup/restore,
and a full blueprint sync. Unit tests: `npm test -w @nav/edge`, `npm test -w @nav/cli`.

## Install on a server

One command sets up a single-server NAV on Ubuntu 22.04 or 24.04 (x86_64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/Ctrl-Joy/nav/landing-auth-dashboard-redesign/scripts/install.sh \
  | sudo bash -s -- --domain onnav.duckdns.org --email you@example.com --duckdns-token <token>
```

From a clone, run `sudo bash scripts/install.sh` with the same flags. It installs Node 24, git, Docker Engine and
PostgreSQL 17 (apt.postgresql.org) for the platform database, creates a `nav` system user, deploys the repo to
`/opt/nav`, builds the dashboard, writes `/etc/nav/*.env`, installs the `nav-control`, `nav-agent` and `nav-edge`
systemd services, opens 80/443 (ufw, and the iptables REJECT rules Oracle images ship with), starts everything and
waits for it to answer. Re-running it is safe.

- **Hostnames.** Apps: `https://<service>.<domain>`. Dashboard and API: `https://dashboard.<domain>`. The edge
  routes `NAV_DASHBOARD_HOST` to the control plane (which listens on 127.0.0.1 only) and never exposes `/internal`;
  the bare domain redirects to the dashboard, and services cannot take the `dashboard` slug.
- **Certificates.** `--duckdns-token` or `--cloudflare-token` lets NAV issue the `*.<domain>` wildcard via DNS-01.
  The first one comes from Let's Encrypt staging (browsers warn); once `journalctl -u nav-control | grep tls` shows
  `issued wildcard certificate`, run `sudo bash /opt/nav/scripts/install.sh --production-certs`. With DuckDNS the
  certificate covers `*.<sub>.duckdns.org` only, not the bare `<sub>.duckdns.org`.
- **Files.** `/etc/nav/nav.env`: `NAV_MASTER_KEY` and the database password, generated once and never overwritten
  (back it up). `/etc/nav/config.env`: rewritten by the installer from its flags (omitted flags keep their previous
  values). `/etc/nav/override.env`: yours (GitHub App, SMTP...), loaded last.
- **Day 2.** `--upgrade` pulls, runs `npm ci`, builds, migrates and restarts. `--uninstall` stops and removes the
  services; `--uninstall --purge` also deletes `/opt/nav`, `/var/lib/nav`, `/etc/nav` and the platform database.
  Logs: `journalctl -u nav-control -u nav-agent -u nav-edge -f`.

### Oracle Cloud Always Free + DuckDNS

1. Create an instance: Ubuntu 24.04 (or 22.04) on the Ampere `VM.Standard.A1.Flex` shape (arm64, free up to
   4 OCPUs / 24 GB), with your SSH key. Note its public IP.
2. In the instance's VCN subnet, open the security list and add ingress rules for TCP 80 and 443 from `0.0.0.0/0`.
3. On [duckdns.org](https://www.duckdns.org), create a subdomain (e.g. `onnav`) pointing at the public IP and copy
   your token. Every name below it (`dashboard.onnav.duckdns.org`, `<service>.onnav.duckdns.org`) resolves to the VM.
4. SSH in and run the installer above with your domain, email and token (`--admin-email` if the admin differs).
5. Open `https://dashboard.onnav.duckdns.org` and sign up with the admin email; that account is the platform admin.
6. When the staging wildcard has been issued, switch to trusted certificates with `--production-certs`.

## Production notes

- Set `NAV_DRIVER=docker`, `NAV_DATABASE_URL`, `NAV_MASTER_KEY` (64 hex chars), `NAV_APPS_DOMAIN`, `NAV_EDGE_PUBLIC_IP`,
  `NAV_EDGE_HTTP_PORT=80`, `NAV_EDGE_HTTPS_PORT=443`, `NAV_PUBLIC_PORT_SUFFIX=`, `NAV_PUBLIC_SCHEME=https`,
  `NAV_ACME_EMAIL` and `NAV_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory`.
- Wildcard certificate for `*.<NAV_APPS_DOMAIN>`: `NAV_DNS_PROVIDER=cloudflare` + `NAV_CLOUDFLARE_API_TOKEN`,
  `NAV_DNS_PROVIDER=duckdns` + `NAV_DUCKDNS_TOKEN` (apps domain `<sub>.duckdns.org`), or `manual` with PEM files.
- To serve the dashboard and API through the edge, set `NAV_DASHBOARD_HOST=dashboard.<apps domain>`, point
  `NAV_DASHBOARD_URL` and `NAV_API_PUBLIC_URL` at `https://` that host, and set `NAV_TRUST_PROXY=loopback`.
- GitHub: create a GitHub App (webhook → `/api/v1/webhooks/github`) and OAuth app; set `NAV_GITHUB_*` (see `packages/shared/src/config.ts`).
- Build the dashboard (`npm run build -w @nav/web`); control serves it from `apps/web/dist`.

## Running on several servers

One control plane (API + scheduler, plus the edge) and any number of agent nodes, all pointed at the same platform
Postgres. Every agent is a node: it registers itself, heartbeats every 10 s, and runs the instances the cluster
places on it.

- **Placement.** Deploys, scaling and restarts choose a node for each instance: it must be online, not draining, run
  a driver that can execute the build, and be able to obtain the build. Replicas of a service are spread across nodes,
  then the node with the most free memory (capacity minus the plans already placed there) wins. A service with a disk
  is pinned to the node that holds the disk.
- **Artifact store.** Once there is more than one node, each build is uploaded to the control plane
  (`/internal/v1/artifacts`, authenticated with a token derived from `NAV_MASTER_KEY`) and verified by SHA-256 when
  another node or the edge fetches it. Docker images travel as `docker save` archives; registry images are pulled by
  each node. `NAV_ARTIFACT_UPLOAD=always|never` overrides the automatic choice.
- **Node failure.** A node silent for 60 s has its instances marked lost; the scheduler places replacements on the
  remaining nodes and the edge stops routing to it. A node that comes back stops the instances it lost.
- **Draining.** `UPDATE nodes SET draining = true WHERE id = '…'` stops new work landing on a node; scale or restart
  its services to move them off.

Per node, set the same `NAV_DATABASE_URL` and `NAV_MASTER_KEY`, plus:

| Variable | Purpose |
| --- | --- |
| `NAV_CONTROL_URL` | Control plane's internal API, e.g. `http://10.0.0.2:4000` (keep it on the private network) |
| `NAV_NODE_ADDRESS` | This node's private IP; the edge and other nodes reach its instances there |
| `NAV_NODE_BIND_IP` | Interface instance ports are published on (defaults to `NAV_NODE_ADDRESS`; never a public IP) |

Locally, `npm run dev -- --agents=2` starts two nodes with separate data directories, and
`NAV_E2E_NODES=2 node scripts/e2e.ts` also checks that replicas land on different nodes.

Current limits: with the Docker driver, private networking (`<service>:<port>` between services) does not span nodes
yet (the process driver runs a balancer for every service on every node, so it does). Postgres databases live on the
node that created them and are not replicated.
