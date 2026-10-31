# NAV architecture

NAV is a self-hostable platform-as-a-service: connect a Git repo, NAV builds it, runs it in an isolated
runtime, puts it behind a TLS-terminating load-balancing edge, and gives you logs, metrics, scaling,
rollbacks, cron, Postgres, custom domains, preview environments and infrastructure-as-code.

```
                ┌──────────── Dashboard (apps/web, React) ───────────┐   CLI (apps/cli)
                └──────────────────────┬─────────────────────────────┘        │
                                       │ REST + SSE  /api/v1                  │
 GitHub ──webhook──►  ┌────────────────▼──────────────────┐◄──────────────────┘
                      │  Control plane (apps/control)     │
                      │  api · auth · scheduler · cron    │
                      │  reconciler · autoscaler · ACME   │
                      └───────┬───────────────────▲───────┘
                     jobs (SKIP LOCKED)    status, logs, metrics
                      ┌───────▼───────────────────┴───────┐
                      │       PostgreSQL (platform DB)    │  LISTEN/NOTIFY: nav_logs, nav_changes, nav_routes
                      └───────▲───────────────────▲───────┘
                              │                   │ edge_routes view + certificates
             ┌────────────────┴──────┐   ┌────────┴──────────────────────┐
             │ Node agent            │   │ Edge (apps/edge)              │
             │ (apps/control/agent)  │   │ HTTP/HTTPS reverse proxy      │
             │ git clone · build     │   │ host routing · round-robin LB │
             │ runtime driver:       │   │ health-aware · WebSockets     │
             │   docker | process    │◄──┤ SNI TLS · ACME HTTP-01        │
             │ health checks · logs  │   │ static sites · HTTP metrics   │
             │ metrics · cron runs   │   └───────────────────────────────┘
             │ postgres provisioner  │
             └───────────────────────┘
```

## Processes

| Process | Entry | Responsibility |
|---|---|---|
| control | `apps/control/src/main.ts` | REST API, auth, GitHub OAuth/App + webhooks, job scheduling, cron scheduler, autoscaler, preview lifecycle, blueprint sync, ACME issuance, log retention |
| agent | `apps/control/src/agent/main.ts` | Claims jobs for its node: build, deploy (zero-downtime swap), run (cron/one-off), stop/scale, database provision/backup/restore. Supervises instances (restart with backoff), runs health checks, samples CPU/memory, ships logs to Postgres |
| edge | `apps/edge/src/main.ts` | Public ingress: `<slug>.<appsDomain>` and verified custom domains → healthy upstream instances. Static sites served from build artifacts. TLS via SNI from `certificates` table (self-signed wildcard in dev). Serves ACME challenges. Writes per-minute `http_metrics`. |
| web | `apps/web` | Dashboard, landing page, onboarding (Vite SPA; in production served by control at `/`). |

All coordination goes through Postgres: a durable job queue (`jobs`, `FOR UPDATE SKIP LOCKED`, per-key
concurrency), `LISTEN/NOTIFY` channels for low-latency fan-out, and the `edge_routes` view as the routing
source of truth. Any process can restart at any time; state is reconstructed from the database.

### NOTIFY channels
- `nav_logs` — payload `<logId>`: new log lines (SSE fan-out).
- `nav_changes` — payload JSON `{workspaceId, entity, id, serviceId?}`: resource state changes (dashboard live updates).
- `nav_routes` — payload `''`: routing table changed (instance became healthy/stopped, domain verified, cert issued, service suspended). Edge reloads.

## Runtime drivers

`NAV_DRIVER=auto|docker|process` (auto = docker if the Docker Engine API is reachable).

**docker** (production): every build produces an immutable image `nav/<serviceId>:<deployId>`. Native runtimes
get a generated Dockerfile (node/python/go/ruby/bun base images); Dockerfile repos build as-is; `image` services pull.
Containers run with: per-plan `Memory`/`NanoCpus`, `PidsLimit 512`, `CapDrop ALL` (+`NET_BIND_SERVICE`),
`no-new-privileges`, non-root user where the image allows, no Docker socket, one bridge network per workspace
(`nav-<workspaceId>`, service slug as DNS alias = private networking), published only on `127.0.0.1:<random>` for the
edge. Disks are named volumes. Postgres databases are `postgres:<ver>` containers with volumes.

**process** (development / single-tenant): builds run in a per-deploy directory, artifacts are copied to
`.nav/artifacts/<deployId>` (immutable → rollbacks), instances are child processes with a scrubbed environment
(no platform secrets inherited), their own port, working dir and process tree (killed as a tree). Postgres
databases are real PostgreSQL clusters (`initdb`/`pg_ctl`) from the `embedded-postgres` binaries. **This driver
does not provide kernel-level isolation** — use docker for untrusted code.

## Deploy pipeline

1. Trigger: git push webhook (branch match + build filter), dashboard/API/CLI, deploy hook, env change, rollback,
   blueprint sync, PR preview.
2. `deploys` row `queued` → job `deploy` (concurrency key = service id; a newer queued deploy cancels older queued ones).
3. **Build** (`build_in_progress`): fetch commit (`git clone --depth 50` + checkout sha), detect runtime, restore build
   cache, run build command, produce artifact. Skipped for rollbacks (artifact reused).
4. **Pre-deploy** (`pre_deploy_in_progress`): optional command (e.g. migrations) in the new artifact with the service env.
5. **Update** (`update_in_progress`): start N new instances; for web/private services wait for the port to listen and
   `healthCheckPath` to return 2xx/3xx (timeout 5 min). Then atomically mark new instances healthy → `NOTIFY nav_routes`,
   mark the previous deploy `deactivated`, drain old instances (SIGTERM, 30 s grace, SIGKILL).
6. `live`. Failure at any step leaves the previous deploy serving (zero-downtime) and marks `*_failed`.

Commit status is reported back to GitHub when the GitHub App is configured.

## Runtime detection (native builds)

| Signal | Runtime | Default build | Default start |
|---|---|---|---|
| `Dockerfile` (runtime docker) | docker | `docker build` | image CMD |
| `bun.lockb`/`bun.lock` | bun | `bun install` | `bun start` |
| `package.json` | node | `npm ci` (or `npm install`), `npm run build` if present | `npm start` |
| `requirements.txt` / `pyproject.toml` | python | `pip install -r requirements.txt` into `.venv` | from Procfile / `gunicorn app:app` |
| `go.mod` | go | `go build -o app .` | `./app` |
| `Gemfile` | ruby | `bundle install` | `bundle exec puma` |
| `Procfile` `web:` line | — | — | overrides default start |

Static sites: build command then publish `publishPath` (default: `dist`, `build`, `public`, `.`).

## Edge routing rules

- Host `<slug>.<appsDomain>` → service with that slug; custom domains → their service; `redirectTo` domains 301.
- `suspended` → 503 "Service suspended" page; no healthy upstream → 502 page while deploying ("Service starting").
- `maintenance_mode` → 503 maintenance page.
- Load balancing: round-robin across healthy upstreams; an upstream with a connection error is ejected for 10 s and
  the request retried once on another upstream (idempotent methods only).
- Headers added: `X-Forwarded-For/Proto/Host`, `X-Request-Id` (generated if absent), `Nav-Instance` response header in dev.
- Static sites: serve files from `artifact.path`; apply `static_routes` (redirect 301 / rewrite) and `static_headers`;
  SPA fallback to `/index.html` when a rewrite `/* → /index.html` is configured; `ETag`, `Cache-Control`, gzip/brotli.
- `/.well-known/acme-challenge/<token>` answered from `acme_challenges` for any host.

## Blueprint spec (`nav.yaml`)

```yaml
services:
  - type: web                # web | private | worker | cron | static
    name: api
    runtime: node            # auto | node | python | go | ruby | bun | docker | image | static
    repo: https://github.com/acme/app   # optional; defaults to the blueprint's repo
    branch: main
    rootDir: services/api
    buildCommand: npm ci && npm run build
    startCommand: npm start
    preDeployCommand: npm run migrate
    healthCheckPath: /healthz
    plan: starter
    numInstances: 2
    autoscaling: { min: 1, max: 4, targetCPUPercent: 70 }
    schedule: "*/5 * * * *"  # cron only
    staticPublishPath: dist  # static only
    disk: { name: data, mountPath: /var/data, sizeGB: 1 }
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase: { name: main-db, property: connectionString }   # connectionString|host|port|user|password|database
      - key: API_HOST
        fromService: { name: worker, type: private, property: hostport } # host|port|hostport
      - key: SESSION_SECRET
        generateValue: true
      - key: STRIPE_KEY
        sync: false          # created empty, value set in the dashboard
      - fromGroup: shared-settings
databases:
  - name: main-db
    plan: basic-256mb
    postgresMajorVersion: 17
    databaseName: app
    user: app
envVarGroups:
  - name: shared-settings
    envVars:
      - key: LOG_LEVEL
        value: info
```

## Security model

- Passwords: scrypt (N=2^15, r=8, p=1) with per-user salt; sessions are random 32-byte tokens stored as SHA-256.
- API keys: `nav_` + 40 random chars, stored hashed; shown once.
- CSRF: SameSite=Lax cookie + mandatory custom header on cookie-authenticated mutations.
- Secrets at rest: AES-256-GCM with `NAV_MASTER_KEY` (env vars, secret files, DB passwords, TLS keys, GitHub tokens).
- Webhooks: GitHub HMAC SHA-256 verified with constant-time compare; deploy hooks use 32-char random keys.
- RBAC per workspace; every resource lookup is scoped through the caller's workspace membership.
- Build/run sandboxes never receive the platform's environment (`NAV_*` platform vars, DB URL, master key).
- Rate limiting on auth endpoints; request body size limits; strict input validation (zod) on every route.
