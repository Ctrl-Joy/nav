# NAV REST API (v1)

Base URL: `http://localhost:4000/api/v1` in development. All bodies are JSON; types live in
[`packages/shared/src/index.ts`](../packages/shared/src/index.ts).

## Authentication

- **Dashboard**: `nav_session` HttpOnly cookie set by `/auth/login` / `/auth/signup`. Mutating requests from the
  browser must send header `X-NAV-CSRF: 1` (any non-simple header; blocks cross-site form posts).
- **CLI / API**: `Authorization: Bearer nav_<token>` (API key). CSRF header not required.
- Workspace-scoped routes take the workspace id in the path. Roles: `owner` > `admin` > `developer` > `viewer`.
  Viewers are read-only; only admins+ manage members, domains, and delete resources.

Errors: HTTP status + `{ "error": { "code": "not_found", "message": "..." } }`.
Lists: `{ "items": [...], "nextCursor": null }` (cursor pagination via `?cursor=&limit=`).

## Auth & account

| Method | Path | Body / Notes | Returns |
|---|---|---|---|
| POST | `/auth/signup` | `{email, password, name}` (password ≥ 8 chars) — creates personal workspace | `{user, workspaces}` |
| POST | `/auth/login` | `{email, password}` | `{user, workspaces}` |
| POST | `/auth/logout` | | `204` |
| GET | `/auth/me` | | `{user, workspaces: Workspace[]}` |
| GET | `/auth/github` | redirects to GitHub OAuth (only if configured) | 302 |
| GET | `/auth/github/callback` | OAuth callback | 302 → dashboard |
| GET | `/config` | public: `{githubEnabled, githubAppSlug, appsDomain, edgeHttpPort, driver, version}` | |
| GET | `/api-keys` | | `Page<ApiKey>` |
| POST | `/api-keys` | `{name}` | `{apiKey: ApiKey, token}` (token shown once) |
| DELETE | `/api-keys/:id` | | `204` |

## Workspaces, members, projects

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces` | `Page<Workspace>` |
| POST | `/workspaces` | `{name}` → `Workspace` |
| PATCH | `/workspaces/:ws` | `{name}` |
| GET | `/workspaces/:ws/members` | `Page<Member>` |
| POST | `/workspaces/:ws/members` | `{email, role}` — adds an existing user, or creates an invite → `{member}` or `{invite:{id,token}}` |
| PATCH | `/workspaces/:ws/members/:userId` | `{role}` |
| DELETE | `/workspaces/:ws/members/:userId` | |
| GET | `/workspaces/:ws/projects` | `Page<Project>` (with environments) |
| POST | `/workspaces/:ws/projects` | `{name, environments?: string[]}` (default `["production"]`) |
| PATCH | `/projects/:id` | `{name}` |
| DELETE | `/projects/:id` | services are detached, not deleted |
| POST | `/projects/:id/environments` | `{name, protected?}` |
| DELETE | `/environments/:id` | |
| GET | `/workspaces/:ws/events` | activity feed `Page<Event>` |
| GET | `/workspaces/:ws/notifications` / PUT | `{webhookUrl, notifyOn}` |

## Git

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:ws/repos` | repos visible via the user's GitHub token / app installations → `Page<Repo>` |
| GET | `/git/branches?repoUrl=` | branch list for any reachable repo (uses `git ls-remote`) → `{items: string[]}` |
| POST | `/webhooks/github` | GitHub webhook receiver (HMAC `X-Hub-Signature-256`), no auth |
| POST | `/deploy-hooks/:serviceId?key=TOKEN` | Deploy hook; optional `?ref=<sha>` or `?imgURL=` → `{deploy}` |

## Services

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:ws/services` | `?type=&environmentId=&q=` → `Page<Service>` (includes previews only with `?includePreviews=1`) |
| POST | `/workspaces/:ws/services` | `CreateServiceInput` → `{service, deploy}` (first deploy auto-queued) |
| GET | `/services/:id` | `Service` |
| PATCH | `/services/:id` | `UpdateServiceInput` → `Service` (does not redeploy; build/start changes apply next deploy) |
| DELETE | `/services/:id` | stops instances, removes routes, deletes data |
| POST | `/services/:id/suspend` | stop all instances, edge serves 503 |
| POST | `/services/:id/resume` | redeploys current artifact |
| POST | `/services/:id/restart` | rolling restart of the live deploy |
| POST | `/services/:id/scale` | `{instanceCount}` |
| GET | `/services/:id/instances` | `Page<Instance>` |
| POST | `/services/:id/deploy-hook/rotate` | → `{deployHookUrl}` |
| GET | `/services/:id/previews` | preview services for PRs → `Page<Service>` |
| POST | `/services/:id/previews` | `{branch, prNumber?}` manual preview → `{service, deploy}` |

### Deploys

| Method | Path | Notes |
|---|---|---|
| GET | `/services/:id/deploys` | `Page<Deploy>` newest first |
| POST | `/services/:id/deploys` | `{clearCache?: boolean, commitSha?: string}` → `Deploy` |
| GET | `/deploys/:id` | `Deploy` |
| POST | `/deploys/:id/cancel` | cancels a queued/in-progress deploy |
| POST | `/deploys/:id/rollback` | redeploys that deploy's artifact without rebuilding → new `Deploy` (trigger `rollback`); auto-deploy setting is left unchanged |

### Environment

| Method | Path | Notes |
|---|---|---|
| GET | `/services/:id/env-vars` | `{items: EnvVar[]}` (values decrypted; viewers get `***`) |
| PUT | `/services/:id/env-vars` | `{envVars: EnvVar[], deploy?: boolean}` replaces the full set; `deploy` (default true) queues an `env_change` deploy |
| PATCH | `/services/:id/env-vars` | `{set?: EnvVar[], remove?: string[], deploy?: boolean}` |
| GET | `/services/:id/secret-files` | `{items: SecretFile[]}` |
| PUT | `/services/:id/secret-files` | `{secretFiles: SecretFile[], deploy?: boolean}` |
| PUT | `/services/:id/env-groups` | `{groupIds: string[]}` linked env groups |
| GET | `/workspaces/:ws/env-groups` | `Page<EnvGroup>` |
| POST | `/workspaces/:ws/env-groups` | `{name, envVars?, secretFiles?}` |
| GET/PATCH/DELETE | `/env-groups/:id` | PATCH `{name?, envVars?, secretFiles?}` (full replace of provided arrays) — linked services redeploy |

Injected variables at runtime: `PORT`, `NAV=true`, `NAV_SERVICE_ID`, `NAV_SERVICE_NAME`, `NAV_SERVICE_TYPE`,
`NAV_INSTANCE_ID`, `NAV_GIT_COMMIT`, `NAV_GIT_BRANCH`, `NAV_GIT_REPO_SLUG`, `NAV_EXTERNAL_URL`,
`NAV_EXTERNAL_HOSTNAME`, `NAV_DISCOVERY_SERVICE`, `IS_PULL_REQUEST`. Secret files are mounted at `/etc/secrets/<name>`
(Docker) or `<appdir>/.nav-secrets/<name>` (process driver, path exposed as `NAV_SECRETS_DIR`) and also in the app root.

### Logs, metrics, events, runs

| Method | Path | Notes |
|---|---|---|
| GET | `/services/:id/logs` | `?stream=build,runtime&deployId=&instanceId=&runId=&q=&level=&before=<id>&after=<id>&since=&until=&limit=200` → `{items: LogLine[]}` ascending |
| GET | `/services/:id/logs/stream` | **SSE**. Same filters; emits `event: log` with `LogLine` JSON. Resume with `?after=<id>`. |
| GET | `/deploys/:id/logs` | build + deploy logs for a single deploy, `?after=` |
| GET | `/deploys/:id/logs/stream` | SSE, closes with `event: end` when the deploy finishes |
| GET | `/services/:id/metrics` | `?range=1h|6h|24h|7d` → `MetricsResponse` |
| GET | `/services/:id/events` | `Page<Event>` |
| GET | `/services/:id/runs` | cron/job runs `Page<Run>` |
| POST | `/services/:id/runs` | one-off job `{command}` (or trigger cron now with `{}`) → `Run` |
| GET | `/runs/:id` | `Run` |
| POST | `/runs/:id/cancel` | |
| GET | `/runs/:id/logs` | `{items: LogLine[]}` |
| GET | `/workspaces/:ws/stream` | **SSE** of workspace changes: `event: change` `{entity:'service'|'deploy'|'database'|'instance', id, serviceId?}` so UIs can invalidate queries |

### Custom domains

| Method | Path | Notes |
|---|---|---|
| GET | `/services/:id/custom-domains` | `{items: CustomDomain[]}` |
| POST | `/services/:id/custom-domains` | `{domain}` — apex adds `www.` redirect automatically; `*.example.com` wildcards allowed |
| POST | `/custom-domains/:id/verify` | DNS check (CNAME → `<slug>.<appsDomain>` or A → edge IP), then issues TLS cert via ACME |
| DELETE | `/custom-domains/:id` | |

## Postgres

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:ws/databases` | `Page<Database>` |
| POST | `/workspaces/:ws/databases` | `{name, plan?, pgVersion?, databaseName?, user?, environmentId?, diskGB?}` → `Database` (status `creating`) |
| GET/PATCH/DELETE | `/databases/:id` | PATCH `{name?, plan?, ipAllowList?, diskGB?}` |
| GET | `/databases/:id/credentials` | `DatabaseCredentials` (admins/developers only) |
| POST | `/databases/:id/suspend`, `/resume`, `/restart` | |
| GET | `/databases/:id/backups` | `Page<DbBackup>` |
| POST | `/databases/:id/backups` | manual backup |
| POST | `/databases/:id/backups/:backupId/restore` | restore in place |
| GET | `/databases/:id/backups/:backupId/download` | `.sql` dump |
| GET | `/databases/:id/logs` + `/logs/stream` | |
| GET | `/databases/:id/metrics` | `?range=` → `{cpu, memoryMB, connections, sizeBytes}` series |
| POST | `/databases/:id/query` | `{sql}` → `{columns, rows, rowCount, durationMs}` (developers+; read-write; 5s timeout; 1000 row cap) |

## Blueprints (Infrastructure as code: `nav.yaml`)

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:ws/blueprints` | `Page<Blueprint>` |
| POST | `/workspaces/:ws/blueprints` | `{name, repoUrl, branch, filePath?}` → `Blueprint` and starts a sync |
| POST | `/blueprints/:id/sync` | manual sync |
| POST | `/blueprints/validate` | `{yaml}` → `{valid, errors, plan: {create:[], update:[], unchanged:[]}}` |
| GET/PATCH/DELETE | `/blueprints/:id` | DELETE `?deleteResources=1` also deletes managed resources |

## Platform

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | liveness (no auth, not under /api/v1) |
| GET | `/admin/nodes` | node agents + heartbeat (owners of any workspace) |
