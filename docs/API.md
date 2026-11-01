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

## Organizations, SAML SSO, SCIM

An org owns several workspaces. Org roles: `owner` > `admin` > `member`; org owners/admins act as owners/admins in
every workspace of the org. Personal workspaces (no org) are unchanged. `/auth/me` also returns `orgs`.

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/orgs` | list mine / `{name, workspaceId?}` — creates the org with a new workspace, or around a workspace you own |
| GET / PATCH / DELETE | `/orgs/:org` | `{name?, requireTwoFactor?, defaultWorkspaceId?, defaultRole?}` (admin); delete needs no workspaces left (owner) |
| GET / POST | `/orgs/:org/members` | `{email, role}` adds an existing account |
| PATCH / DELETE | `/orgs/:org/members/:userId` | `{role}`; removal also removes them from the org's workspaces; last owner is protected |
| GET / POST | `/orgs/:org/workspaces` | members see their own; admins see all / `{name}` |
| POST | `/orgs/:org/workspaces/:workspaceId/attach` · `/detach` | move a workspace you own in (admin) / out (owner) |
| GET / POST | `/orgs/:org/domains` | `{domain}` → `{txtName: "_nav-verify.<domain>", txtValue: "nav-verify=<token>", ...}` |
| POST / DELETE | `/orgs/:org/domains/:domainId/verify` · `/orgs/:org/domains/:domainId` | checks the TXT record |
| GET / PUT / DELETE | `/orgs/:org/saml` | SP details + IdP settings / `{metadataXml}` or `{entityId, ssoUrl, certificate, binding}`, plus `{enabled, enforce}` |
| GET | `/orgs/:org/scim` | base URL, tokens, pushed groups |
| POST / DELETE | `/orgs/:org/scim/tokens` · `/orgs/:org/scim/tokens/:tokenId` | token is shown once (stored hashed) |
| PATCH | `/orgs/:org/scim/groups/:groupId` | `{workspaceId, role}` maps a SCIM group to a workspace role (or `null`s to unmap) |
| GET | `/orgs/:org/audit-logs` | org settings, SAML sign-ins, SCIM changes and all the org's workspaces |

SAML (service provider, per org; SP-initiated only):
`GET /auth/saml/:org/metadata`, `GET /auth/saml/:org/login?next=` (signed AuthnRequest, redirect or POST binding),
`POST /auth/saml/:org/acs`. Responses must be signed (Response or Assertion) by a configured IdP certificate, for our
audience/ACS, within NotBefore/NotOnOrAfter (90 s skew), answering a request we issued (single use), with an email in
a verified domain. Users are provisioned just in time into the default workspace; sessions go through 2FA.
`POST /auth/sso {email}` routes to the org's SAML login when the domain is verified by an org with SAML on. With
`enforce`, password sign-in, sign-up, password reset and OAuth are refused for that domain (`403 sso_required`).

SCIM 2.0 at `/scim/v2` (not under `/api/v1`), `Authorization: Bearer nav_scim_…`: `Users` (list with
`filter=userName eq "…"`, get, create, PUT, PATCH incl. `active: false`, DELETE), `Groups` (same verbs; members),
`ServiceProviderConfig`, `ResourceTypes`, `Schemas`. Deactivating or deleting a user removes them from the org and
its workspaces and revokes their sessions and API keys. Users must have an email in a verified domain.

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
| GET/PATCH/DELETE | `/databases/:id` | PATCH `{name?, plan?, ipAllowList?, diskGB?, highAvailability?}` |
| GET | `/databases/:id/credentials` | `DatabaseCredentials` (admins/developers only) |
| POST | `/databases/:id/suspend`, `/resume`, `/restart` | |
| GET | `/databases/:id/backups` | `Page<DbBackup>` |
| POST | `/databases/:id/backups` | manual backup |
| POST | `/databases/:id/backups/:backupId/restore` | restore in place |
| GET | `/databases/:id/backups/:backupId/download` | `.sql` dump |
| GET | `/databases/:id/logs` + `/logs/stream` | |
| GET | `/databases/:id/metrics` | `?range=` → `{cpu, memoryMB, connections, sizeBytes}` series |
| POST | `/databases/:id/query` | `{sql}` → `{columns, rows, rowCount, durationMs}` (developers+; read-write; 5s timeout; 1000 row cap) |
| GET | `/databases/:id/recovery` | `DbRecoveryWindow` — point-in-time recovery window `{enabled, retentionDays, earliest, latest, reason}` (free: off; basic: 3 days; pro: 7 days) |
| POST | `/databases/:id/recover` | `{targetTime, name?}` → `202 Database`: a NEW database restored from the newest base backup before `targetTime`, WAL replayed to `recovery_target_time`, then promoted |
| GET/POST | `/databases/:id/replicas` | `Page<DbReplica>` with live replication lag; POST `{name?}` creates a streaming read replica (paid plans, max 5) |
| DELETE | `/databases/:id/replicas/:replicaId` | the HA standby is removed with `PATCH {highAvailability:false}` instead |
| GET/POST/DELETE | `/databases/:id/pooler` | `DbPooler`; POST enables PgBouncer (transaction mode) — `409` when PgBouncer is not installed on the node (`NAV_PGBOUNCER` / PATH) |
| GET/POST | `/databases/:id/extensions` | allow-listed extensions from `pg_available_extensions`; POST `{name}` runs `CREATE EXTENSION … CASCADE` |
| DELETE | `/databases/:id/extensions/:name` | `?cascade=true` to drop dependent objects (409 otherwise) |
| GET/POST | `/databases/:id/upgrade` | `DbUpgradeInfo` (targets installed on the node and method); POST `{version}` (admins) → `202 DbOperation` |
| GET | `/databases/:id/insights/slow-queries` | top 20 statements by total time (`pg_stat_statements`); POST `…/reset` |
| GET | `/databases/:id/insights/tables` | sizes, dead rows, estimated bloat |
| POST | `/databases/:id/repack` | `{schema?, table}` (admins) → `202 DbOperation`: pg_repack if installed, else `VACUUM (FULL, ANALYZE)` (locks the table) |
| GET | `/databases/:id/operations` | recent upgrades / repacks / recoveries / failovers |

High availability: with `highAvailability: true` a hot standby streams from the primary on the same node. If the primary
does not answer for `NAV_PG_FAILOVER_SECONDS` (default 30), the agent fences it, promotes the standby, moves it into the
database's data directory and restarts it **on the primary's port**, so connection strings keep working. If that port
cannot be bound the standby keeps its own port and the database's external port changes (recorded in the
`database_failover` event and shown in the dashboard). A new standby is then built. The standby lives on the same node
as the primary: it protects against PostgreSQL crashes and data-directory failures, not against losing the node.
Tools: embedded-postgres ships only `initdb`/`pg_ctl`/`postgres`; set `NAV_PG_BIN_DIRS` to the bin directory of a full
PostgreSQL install (or put it on PATH) for `pg_basebackup`, `pg_upgrade`, `pg_dump`/`pg_restore` and other major versions.
Without `pg_basebackup`, replicas are cloned with an online base backup over a replication slot.

## Sandboxes

Isolated, short-lived environments for running code (for example from AI agents). Viewers can list and inspect;
developers create, run commands, move files and snapshot. Every exec is audited (`sandbox.exec`) with its command
and exit code, never its output. Limits: TTL 60 s – 24 h (default 15 min); 10 live sandboxes per workspace
(`workspaces.sandbox_limit` overrides); 50 snapshots per workspace; exec timeout 1 – 3600 s (default 60);
1 MiB of stdout and of stderr per synchronous exec; 64 KiB commands; 1 MiB stdin; 50 MiB per file; 100 env vars;
8 concurrent commands per sandbox.

| Method | Path | Notes |
|---|---|---|
| GET | `/sandbox-plans` | `{plans, images, limits}` |
| GET | `/workspaces/:ws/sandboxes` | `?status=live\|all` → `{items: Sandbox[]}` |
| POST | `/workspaces/:ws/sandboxes` | `{runtime?: node\|python\|bash, image?, plan?, ttlSeconds?, env?, networkAccess?: none\|egress, snapshotId?, name?}` → `Sandbox` (201, running); 429 `sandbox_limit` |
| GET/DELETE | `/sandboxes/:id` | DELETE kills its commands and removes its files (the row stays, status `stopped`) |
| POST | `/sandboxes/:id/exec` | `{command, cwd?, env?, timeoutSeconds?, stdin?}` → `{exitCode, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, durationMs}`; on timeout the whole process tree is killed and `exitCode` is null |
| GET (WS) | `/sandboxes/:id/exec/stream` | WebSocket. Send `{type:'start', command?, cwd?, env?, timeoutSeconds?, tty?, cols?, rows?}` (no command = interactive shell); receive binary frames `[1=stdout\|2=stderr, ...bytes]`, then `{type:'exit', code, timedOut}`. Send binary frames (stdin), `{type:'eof'}`, `{type:'resize', cols, rows}`, `{type:'kill'}` |
| PUT | `/sandboxes/:id/files?path=&mode=` | raw body (`application/octet-stream`) → `{size}` |
| GET | `/sandboxes/:id/files?path=` | raw bytes |
| DELETE | `/sandboxes/:id/files?path=&recursive=1` | |
| GET | `/sandboxes/:id/ls?path=` | `{items: [{name, path, type, size, modifiedAt}]}` |
| POST | `/sandboxes/:id/snapshots` | `{name?}` → `SandboxSnapshot` (archives /workspace into the artifact store) |
| GET | `/workspaces/:ws/sandbox-snapshots` | `?sandboxId=` |
| GET/DELETE | `/sandbox-snapshots/:id` | |

Paths are relative to `/workspace` (`a/b`, `/a/b` and `/workspace/a/b` are the same file); `..`, backslashes, `:`
and control characters are refused, and symlinks that lead outside the sandbox are refused (403).

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
