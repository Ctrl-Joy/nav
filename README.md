# NAV

A self-hostable platform-as-a-service: connect a Git repo and NAV builds it, runs it in isolated instances behind a
TLS-terminating load-balancing edge, and gives you logs, metrics, scaling, rollbacks, cron jobs, managed PostgreSQL,
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

Then create a service from `http://localhost:9420/node-web.git` (also `static-site`, `worker`, `cron-job`, and
`examples.git` with a `nav.yaml` blueprint).

## Tests

```bash
node scripts/e2e.ts
```

End-to-end against the running stack: Git build → live via edge, SSE logs, crash self-healing, scaling + round-robin,
zero-downtime env redeploy, rollback without rebuild, deploy hooks, suspend/resume, metrics, custom domain + TLS via SNI,
static sites (ETag/304/404), workers, cron (manual + scheduled + failure codes), Postgres provision/query/backup/restore,
and a full blueprint sync. Unit tests: `npm test -w @nav/edge`, `npm test -w @nav/cli`.

## Production notes

- Set `NAV_DRIVER=docker`, `NAV_DATABASE_URL`, `NAV_MASTER_KEY` (64 hex chars), `NAV_APPS_DOMAIN`, `NAV_EDGE_PUBLIC_IP`,
  `NAV_EDGE_HTTP_PORT=80`, `NAV_EDGE_HTTPS_PORT=443`, `NAV_PUBLIC_PORT_SUFFIX=`, `NAV_PUBLIC_SCHEME=https`,
  `NAV_ACME_EMAIL` and `NAV_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory`.
- GitHub: create a GitHub App (webhook → `/api/v1/webhooks/github`) and OAuth app; set `NAV_GITHUB_*` (see `packages/shared/src/config.ts`).
- Build the dashboard (`npm run build -w @nav/web`); control serves it from `apps/web/dist`.
