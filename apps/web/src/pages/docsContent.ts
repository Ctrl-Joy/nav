/** Content for the public /docs page. Inline `code` spans are supported inside "p" and "list" blocks. */

export type DocBlock =
  | { type: 'p'; text: string }
  | { type: 'h3'; text: string; id?: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; code: string };

export type DocGroup = 'Getting started' | 'Services' | 'Platform' | 'Operate' | 'Reference';

export interface DocSection {
  slug: string;
  group: DocGroup;
  title: string;
  blocks: DocBlock[];
}

export const DOC_GROUPS: DocGroup[] = ['Getting started', 'Services', 'Platform', 'Operate', 'Reference'];

export const DOC_SECTIONS: DocSection[] = [
  {
    slug: 'getting-started',
    group: 'Getting started',
    title: 'Getting started',
    blocks: [
      {
        type: 'p',
        text: "NAV is a self-hostable platform-as-a-service. You connect a Git repository, NAV builds it, runs it in isolated instances behind a TLS-terminating edge, and gives you logs, metrics, scaling, rollbacks, cron jobs, Postgres, custom domains and preview environments.",
      },
      {
        type: 'p',
        text: "Once a service's first deploy is live it is reachable at `<slug>.<appsDomain>`. Each change to source, settings or environment variables produces a new immutable deploy, and the previous deploy keeps serving until the new one is healthy.",
      },
      { type: 'h3', text: 'Run it locally' },
      {
        type: 'p',
        text: "You need Node 24 or newer and git. Docker is optional.",
      },
      {
        type: 'code',
        code: `npm install
npm run dev`,
      },
      {
        type: 'p',
        text: "This starts an embedded PostgreSQL for the platform, the control plane, the node agent, the edge and the dashboard at `http://localhost:5180`. Apps are served at `http://<service>.nav.localhost:7080`. Sign up to create a personal workspace, then create a service and deploy it.",
      },
      {
        type: 'p',
        text: "Without Docker the agent uses the process driver. It runs real builds and real processes, but it provides no container isolation.",
      },
    ],
  },
  {
    slug: 'quickstarts',
    group: 'Getting started',
    title: 'Quickstarts',
    blocks: [
      {
        type: 'p',
        text: "Each quickstart is a short path from an empty workspace to a running service. The commands assume you have run `nav login` and selected a workspace.",
      },
      { type: 'h3', text: 'Web service from a repository' },
      {
        type: 'code',
        code: `nav services create --name api --type web --repo https://github.com/acme/app --branch main
nav deploy api --wait
nav logs api --tail
nav open api`,
      },
      {
        type: 'p',
        text: "NAV detects the runtime from files in the repository, such as `package.json`, `requirements.txt`, `go.mod`, `Gemfile` or a `Dockerfile`. A `web:` line in a `Procfile` always sets the start command, and any command can be overridden in the service settings.",
      },
      { type: 'h3', text: 'Node.js', id: 'runtime-node' },
      {
        type: 'p',
        text: "Chosen when the repository has a `package.json`. The package manager follows the lockfile: `pnpm-lock.yaml` uses pnpm, `yarn.lock` uses Yarn, otherwise npm (`npm ci` with a `package-lock.json`). If there is a `build` script it runs after installing. The start command is the `start` script, then `main` from `package.json`, then `server.js` or `index.js`. Listen on `PORT` and `0.0.0.0`.",
      },
      { type: 'h3', text: 'Python', id: 'runtime-python' },
      {
        type: 'p',
        text: "Chosen for `requirements.txt`, `pyproject.toml` or a `Pipfile`. NAV creates a virtual environment in `.venv` and installs `requirements.txt` (or the project itself). Django projects (`manage.py`) start with `gunicorn wsgi:application`, `app.py` with `gunicorn app:app`, and `main.py` with `python main.py`.",
      },
      { type: 'h3', text: 'Go', id: 'runtime-go' },
      {
        type: 'p',
        text: "Chosen for a `go.mod`. NAV runs `go build -o app .` and starts `./app`. Read the port from the `PORT` environment variable.",
      },
      { type: 'h3', text: 'Bun', id: 'runtime-bun' },
      {
        type: 'p',
        text: "Chosen when the repository has `bun.lock` or `bun.lockb`, even alongside a `package.json`. NAV runs `bun install` and starts with `bun start`.",
      },
      { type: 'h3', text: 'Try the bundled examples without GitHub', id: 'examples' },
      {
        type: 'p',
        text: "Serve the example apps over local Git smart-HTTP, then create a service from `http://localhost:9420/node-web.git`. The same server also offers `static-site`, `worker`, `cron-job`, and `examples.git`, which contains a `nav.yaml` blueprint.",
      },
      { type: 'code', code: 'node scripts/git-serve.ts' },
    ],
  },
  {
    slug: 'web-services',
    group: 'Services',
    title: 'Web services',
    blocks: [
      {
        type: 'p',
        text: "A web service (`type: web`) is a long-running HTTP server. NAV starts the new instances, waits until the port is listening and `healthCheckPath` returns a 2xx or 3xx response, and only then moves traffic to them.",
      },
      {
        type: 'p',
        text: "Build and start commands are inferred from the runtime, and you can override them in `nav.yaml` or in the service settings. Build and start changes apply on the next deploy. Listen on the `PORT` variable that NAV injects. For native runtimes, a `Procfile` `web:` line overrides the default start command.",
      },
      {
        type: 'code',
        code: `services:
  - type: web
    name: api
    runtime: node
    branch: main
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /healthz
    plan: starter
    numInstances: 2`,
      },
    ],
  },
  {
    slug: 'private-services',
    group: 'Services',
    title: 'Private services',
    blocks: [
      {
        type: 'p',
        text: "A private service (`type: private`) runs like a web service but gets no public hostname. Only other services in the same workspace can reach it, through the private network.",
      },
      {
        type: 'p',
        text: "Its health checks are the same as for web services. Other services read its address with `fromService` in `envVars`, using the `host`, `port` or `hostport` property.",
      },
      {
        type: 'code',
        code: `envVars:
  - key: API_HOST
    fromService: { name: internal-api, type: private, property: hostport }`,
      },
    ],
  },
  {
    slug: 'background-workers',
    group: 'Services',
    title: 'Background workers',
    blocks: [
      {
        type: 'p',
        text: "A worker (`type: worker`) is a long-running process with no public route. Use it for queue consumers, schedulers and other background tasks.",
      },
      {
        type: 'p',
        text: "The node agent supervises every instance. If a process exits, it is restarted with backoff. Workers take part in zero-downtime deploys like other services: new instances start first, then the old ones are drained with SIGTERM and a 30-second grace period before SIGKILL.",
      },
    ],
  },
  {
    slug: 'cron-jobs',
    group: 'Services',
    title: 'Cron jobs',
    blocks: [
      {
        type: 'p',
        text: "A cron service (`type: cron`) runs a command on a schedule. Schedules are standard cron expressions evaluated in UTC.",
      },
      {
        type: 'p',
        text: "A run does not start while the previous run of the same job is still active. Every run records its exit code, so failed runs are visible in the run history. You can also start a run on demand.",
      },
      {
        type: 'code',
        code: `services:
  - type: cron
    name: nightly-report
    runtime: node
    schedule: "0 3 * * *"
    startCommand: node scripts/report.js`,
      },
      {
        type: 'p',
        text: "For a one-off command in the service's environment, use `nav run <service> --wait -- <command...>`. `nav jobs <service>` lists one-off jobs and cron runs.",
      },
    ],
  },
  {
    slug: 'static-sites',
    group: 'Services',
    title: 'Static sites',
    blocks: [
      {
        type: 'p',
        text: "A static site (`runtime: static`) runs an optional build command and then publishes a directory of build output. The publish path defaults to `dist`, `build`, `public` or `.`, the repository root.",
      },
      {
        type: 'p',
        text: "The edge serves files from the immutable build artifact with ETag, Cache-Control and gzip or brotli compression, and returns 404 for missing files. Redirect and rewrite rules and custom headers are applied at the edge. A `/*` to `/index.html` rewrite gives a single-page app its fallback route.",
      },
      {
        type: 'code',
        code: `services:
  - type: static
    name: marketing
    runtime: static
    buildCommand: npm ci && npm run build
    staticPublishPath: dist`,
      },
    ],
  },
  {
    slug: 'postgres',
    group: 'Services',
    title: 'Postgres',
    blocks: [
      {
        type: 'p',
        text: "Managed Postgres databases run as PostgreSQL 17 clusters by default; the major version is set with `postgresMajorVersion` in `nav.yaml` or `--version` on the CLI. Create a database from the dashboard, the API or `nav db create`.",
      },
      {
        type: 'p',
        text: "Connection details come from `nav db info`, from the credentials endpoint (admins and developers only), or from `fromDatabase` in an environment variable. That field can reference `connectionString`, `host`, `port`, `user`, `password` or `database`. Use `ipAllowList` to restrict which addresses may connect.",
      },
      {
        type: 'code',
        code: `nav db create --name main-db --version 17
nav db info main-db
nav db query main-db "SELECT now()"
nav db backup main-db`,
      },
      {
        type: 'p',
        text: "Queries run from the dashboard or `nav db query` are read-write, require the developer role or higher, time out after 5 seconds and return at most 1,000 rows. Backups can be taken on demand and restored in place, or downloaded as a `.sql` dump. Backups and restores are implemented for the process driver only; Docker-driver backups are not built yet.",
      },
    ],
  },
  {
    slug: 'key-value',
    group: 'Services',
    title: 'Key Value',
    blocks: [
      {
        type: 'p',
        text: 'Key Value instances are managed Redis-compatible stores for caches, queues and sessions. Create one from New → Key Value; pick a plan (its memory is the `maxmemory` limit) and an eviction policy such as `allkeys-lru` for caches or `noeviction` for queues.',
      },
      {
        type: 'p',
        text: 'Services in the workspace connect with the internal URL over the private network. The external URL is only reachable from addresses in the inbound IP rules; with no rules, external access is off. Connection strings are revealed on the Info tab to developers and admins.',
      },
    ],
  },
  {
    slug: 'persistent-disks',
    group: 'Services',
    title: 'Persistent disks',
    blocks: [
      {
        type: 'p',
        text: "A disk is a named volume mounted into a service at a path you choose. Declare it on the service in `nav.yaml`:",
      },
      {
        type: 'code',
        code: `disk: { name: data, mountPath: /var/data, sizeGB: 1 }`,
      },
      {
        type: 'p',
        text: "On the Docker driver a disk is a named volume, so its contents survive deploys. Because the data cannot be shared by two running copies, a service with a disk is deployed stop-first: the old instance stops before the new one starts, which means a short outage on each deploy.",
      },
      {
        type: 'p',
        text: "NAV snapshots each disk daily, and you can take a manual snapshot from the service's Disks tab. Restoring a snapshot (admins only) restarts the service and replaces the disk's contents.",
      },
    ],
  },
  {
    slug: 'environment-variables',
    group: 'Platform',
    title: 'Environment variables',
    blocks: [
      {
        type: 'p',
        text: "Set variables per service in the dashboard, through the API (`PUT` replaces the full set, `PATCH` sets or removes individual keys), or with the CLI. Values are encrypted at rest with AES-256-GCM using `NAV_MASTER_KEY`. Viewers see masked values.",
      },
      {
        type: 'p',
        text: "Saving a change queues an `env_change` deploy by default, so running instances pick up the new values. Use `--no-deploy` on the CLI, or `deploy: false` in the API, to save without deploying.",
      },
      {
        type: 'code',
        code: `nav env set api NODE_ENV=production LOG_LEVEL=info
nav env pull api --file .env
nav env unset api OLD_FLAG`,
      },
      {
        type: 'p',
        text: "Env groups are shared sets of variables and secret files that can be linked to several services. Groups are merged by name, and changing a group redeploys the services linked to it.",
      },
      {
        type: 'p',
        text: "Secret files are mounted at `/etc/secrets/<name>` on Docker, or at `.nav-secrets/<name>` inside the app directory on the process driver, where the directory is exposed as `NAV_SECRETS_DIR`. They are also available in the app root.",
      },
      { type: 'h3', text: 'Injected variables' },
      {
        type: 'p',
        text: "Every instance receives `PORT`, `NAV=true`, `NAV_SERVICE_ID`, `NAV_SERVICE_NAME`, `NAV_SERVICE_TYPE`, `NAV_INSTANCE_ID`, `NAV_GIT_COMMIT`, `NAV_GIT_BRANCH`, `NAV_GIT_REPO_SLUG`, `NAV_EXTERNAL_URL`, `NAV_EXTERNAL_HOSTNAME`, `NAV_DISCOVERY_SERVICE` and `IS_PULL_REQUEST`.",
      },
      {
        type: 'p',
        text: "In `nav.yaml`, `generateValue: true` creates a random value, and `sync: false` creates the variable empty so you can set its value later in the dashboard.",
      },
    ],
  },
  {
    slug: 'deploys',
    group: 'Platform',
    title: 'Deploys',
    blocks: [
      {
        type: 'p',
        text: "Each deploy records its trigger, status and logs. A deploy can be triggered by a git push (filtered by branch and build filter), the dashboard, the API or CLI, a deploy hook, an environment change, a rollback, a blueprint sync, or a pull request preview. A newer queued deploy cancels older queued ones for the same service.",
      },
      { type: 'h3', text: 'Lifecycle' },
      {
        type: 'list',
        items: [
          "Build: fetches the commit, detects the runtime, restores the build cache, runs the build command and produces an immutable artifact. Rollbacks skip this step.",
          "Pre-deploy: an optional command, such as a database migration, runs in the new artifact with the service's environment.",
          "Update: starts the new instances. Web and private services must listen on their port and return 2xx or 3xx from `healthCheckPath` within five minutes. NAV then marks the new instances healthy, reloads the edge and drains the old instances.",
          "Live: the new deploy serves traffic. If any step fails, the previous deploy keeps serving and the deploy is marked with the step that failed.",
        ],
      },
      { type: 'h3', text: 'Rollbacks' },
      {
        type: 'p',
        text: "A rollback redeploys the artifact of an earlier deploy without rebuilding it, which is quick and reproducible because artifacts never change. Rollbacks leave your auto-deploy setting as it is.",
      },
      { type: 'code', code: 'nav rollback api <deployId>' },
      { type: 'h3', text: 'Deploy hooks and skip markers' },
      {
        type: 'p',
        text: "Each service has a deploy hook: `POST /api/v1/deploy-hooks/<serviceId>?key=<key>`. The key is a random 32-character value that you can rotate. Add `ref=<sha>` to deploy a specific commit, or `imgURL=` to point an image service at a new image.",
      },
      {
        type: 'p',
        text: "A commit whose message contains `[skip ci]` does not trigger a deploy. Build filters are glob patterns on paths, so a push only deploys when it changes files that match.",
      },
    ],
  },
  {
    slug: 'preview-environments',
    group: 'Platform',
    title: 'Preview environments',
    blocks: [
      {
        type: 'p',
        text: "When a pull request is opened or updated, NAV creates a preview service for it, deploys the pull request's commit, and comments on the pull request with the preview URL. The preview is deleted automatically when the pull request closes. Previews are also subject to expiry.",
      },
      {
        type: 'p',
        text: "Previews are hidden from the normal service list. Use `?includePreviews=1` on the API, or the service's Previews tab, to see them. You can also create a preview by hand with a branch and an optional PR number.",
      },
      {
        type: 'code',
        code: `POST /api/v1/services/<serviceId>/previews
{ "branch": "feature/login", "prNumber": 42 }`,
      },
      {
        type: 'p',
        text: "Preview environments are per service. Whole-stack blueprint previews are not built yet.",
      },
    ],
  },
  {
    slug: 'infrastructure-as-code',
    group: 'Platform',
    title: 'Infrastructure as code',
    blocks: [
      {
        type: 'p',
        text: "A blueprint is a `nav.yaml` file in your repository that describes services, databases and environment variable groups. NAV reconciles the workspace with it: it creates what is missing, updates what changed and leaves the rest alone. Blueprints sync automatically on push and can also be synced by hand.",
      },
      {
        type: 'p',
        text: "Validate before you launch. `nav blueprint validate` and `POST /blueprints/validate` report errors and a plan of what would be created, updated or left unchanged.",
      },
      {
        type: 'p',
        text: "Resources reference each other by name. `fromDatabase` reads a connection value from a database, `fromService` reads a private service's address, `fromGroup` pulls in an env var group, `generateValue` creates a random value and `sync: false` leaves a value empty for you to fill in.",
      },
      {
        type: 'code',
        code: `services:
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
        value: info`,
      },
      {
        type: 'code',
        code: `nav blueprint validate nav.yaml
nav blueprint launch --repo https://github.com/acme/app --branch main
nav blueprint sync <id|name>`,
      },
    ],
  },
  {
    slug: 'scaling',
    group: 'Platform',
    title: 'Scaling',
    blocks: [
      {
        type: 'p',
        text: "Each service runs `numInstances` copies by default. Change the count in the dashboard, with `nav services scale <id> <count>`, or with `POST /services/:id/scale` and an `instanceCount` body. The edge spreads requests across healthy instances in round-robin order.",
      },
      {
        type: 'p',
        text: "If an instance returns a connection error, the edge ejects it for 10 seconds and retries the request once on another instance. Only idempotent methods are retried.",
      },
      { type: 'h3', text: 'Autoscaling' },
      {
        type: 'p',
        text: "Autoscaling keeps the instance count between a minimum and a maximum. A proportional controller works towards the CPU target, and scale-down waits for a five-minute cool-down so brief dips do not remove capacity.",
      },
      {
        type: 'code',
        code: `autoscaling: { min: 1, max: 4, targetCPUPercent: 70 }`,
      },
      { type: 'h3', text: 'Free instances' },
      {
        type: 'p',
        text: "Web services on the `free` plan spin down after 15 minutes without inbound HTTP traffic and show as Sleeping. The next request wakes the service: the edge holds it for up to a minute while an instance starts, then forwards it with an `x-nav-woke: 1` header, so the first response takes a few seconds. If the service is not up in time, the edge answers 503 with `Retry-After`. Deploying, restarting or moving to a paid plan also wakes it, and paid plans never sleep. Background workers and private services never spin down. Operators set the idle time with `NAV_FREE_SLEEP_MINUTES` (0 disables sleeping).",
      },
    ],
  },
  {
    slug: 'custom-domains',
    group: 'Platform',
    title: 'Custom domains',
    blocks: [
      {
        type: 'p',
        text: "Add a domain with `nav domains add <service> <domain>` or the API. An apex domain automatically gets a `www.` redirect to it. Wildcard names such as `*.example.com` are accepted, but wildcard certificates need DNS-01 validation, which is not implemented yet.",
      },
      { type: 'h3', text: 'DNS records' },
      {
        type: 'list',
        items: [
          "A CNAME from the domain to `<slug>.<appsDomain>`, for subdomains.",
          "An A record pointing at the edge's public IP (`NAV_EDGE_PUBLIC_IP`), which is the option for apex domains because they cannot use a CNAME.",
        ],
      },
      {
        type: 'code',
        code: `nav domains add api www.example.com
nav domains verify <domainId>`,
      },
      {
        type: 'p',
        text: "Verification checks the DNS record. Only after it succeeds does NAV issue a certificate, using ACME HTTP-01 challenges answered at `/.well-known/acme-challenge/`.",
      },
      { type: 'h3', text: 'TLS' },
      {
        type: 'p',
        text: "The edge terminates TLS and picks the certificate for each connection by SNI, reading from the certificate store in Postgres. Production uses Let's Encrypt through `NAV_ACME_DIRECTORY`. In development NAV uses a local CA and a self-signed wildcard certificate.",
      },
    ],
  },
  {
    slug: 'private-network',
    group: 'Platform',
    title: 'Private network',
    blocks: [
      {
        type: 'p',
        text: "Services in the same workspace can call each other without going through the public edge. On the Docker driver each workspace gets its own bridge network, named `nav-<workspaceId>`. Each service's slug is a DNS alias on that network, so a private service named `worker` is reachable at `http://worker:<port>`.",
      },
      {
        type: 'p',
        text: "Container ports are published only on `127.0.0.1`, for the edge to reach. Services in different workspaces are on different networks and cannot reach each other.",
      },
      {
        type: 'p',
        text: "On the process driver there is no container network. NAV runs a load balancer per service on a stable port instead, and the `hostport` property of `fromService` gives the address to use.",
      },
    ],
  },
  {
    slug: 'logs-and-metrics',
    group: 'Operate',
    title: 'Logs and metrics',
    blocks: [
      {
        type: 'p',
        text: "Build output and runtime output are stored in Postgres and fanned out to the dashboard and CLI over server-sent events. Filter by stream (`build` or `runtime`), deploy, instance, level or text. Logs are kept for seven days.",
      },
      {
        type: 'code',
        code: `nav logs api --tail
nav logs api --stream build --search "npm ERR"`,
      },
      {
        type: 'p',
        text: "Metrics track CPU and memory for each instance, and HTTP requests seen by the edge, recorded per minute. The dashboard and `nav metrics` show the latest values with trends. The API accepts ranges of `1h`, `6h`, `24h` and `7d`.",
      },
    ],
  },
  {
    slug: 'docker',
    group: 'Operate',
    title: 'Docker',
    blocks: [
      {
        type: 'p',
        text: "With `NAV_DRIVER=docker`, or with `auto` when the Docker Engine API is reachable, every build becomes an immutable image tagged `nav/<serviceId>:<deployId>`.",
      },
      {
        type: 'p',
        text: "Native runtimes get a generated Dockerfile on a Node, Python, Go, Ruby or Bun base image. A repository with its own `Dockerfile` is built as it is, and `image` services pull a prebuilt image.",
      },
      { type: 'h3', text: 'Bring your own Dockerfile', id: 'dockerfile' },
      {
        type: 'p',
        text: "A `Dockerfile` at the root (or at the path set in the service's Dockerfile path, with its own build context) is used as it is. Build arguments named `NAV_*` are passed in. Images from a private registry need a registry credential, added in workspace settings and selected on the service.",
      },
      { type: 'h3', text: 'Container limits' },
      {
        type: 'p',
        text: "Containers run with these limits:",
      },
      {
        type: 'list',
        items: [
          "Memory and CPU limits from the service plan",
          "A process limit of 512",
          "All Linux capabilities dropped except NET_BIND_SERVICE, and no-new-privileges set",
          "A non-root user where the image allows it",
          "No Docker socket inside the container",
          "One bridge network per workspace",
        ],
      },
    ],
  },
  {
    slug: 'cli',
    group: 'Reference',
    title: 'CLI',
    blocks: [
      {
        type: 'p',
        text: "The `nav` command is a client for the REST API. `nav login` saves a token in `~/.nav/config.json`. The environment variables `NAV_HOST`, `NAV_TOKEN` and `NAV_WORKSPACE` override the saved config, and `NO_COLOR` turns off colour. Add `--json` to any command for machine-readable output, and run `nav help <command>` for usage.",
      },
      {
        type: 'list',
        items: [
          "`nav login`, `nav logout`, `nav whoami`: sign in, sign out, show the current user, host and workspace",
          "`nav workspaces`, `nav workspace use <id|slug>`: list workspaces and select one",
          "`nav services`: list, `show`, `create`, `delete`, `suspend`, `resume`, `restart` and `scale` services",
          "`nav deploy <service>`, `nav deploys <service>`, `nav deploys cancel <deployId>`, `nav rollback <service> <deployId>`",
          "`nav logs <service>` with `--tail`, `--stream`, `--level`, `--search` and `--limit`",
          "`nav metrics`, `nav open <service>`",
          "`nav env <service>`, with `set`, `unset`, `pull` and `push`",
          "`nav domains <service>`, with `add`, `verify` and `rm`",
          "`nav db` with `list`, `create`, `info`, `psql`, `backup` and `query`",
          "`nav jobs <service>`, `nav run <service> -- <command...>`",
          "`nav blueprint` with `validate`, `launch` and `sync`",
        ],
      },
      {
        type: 'code',
        code: `nav login --host http://localhost:4000
nav services --json
nav deploy api --wait`,
      },
    ],
  },
  {
    slug: 'rest-api',
    group: 'Reference',
    title: 'REST API',
    blocks: [
      {
        type: 'p',
        text: "The REST API lives under `/api/v1`, for example `http://localhost:4000/api/v1` in development. Bodies are JSON. The dashboard signs in with an HttpOnly session cookie and must send `X-NAV-CSRF: 1` on mutating requests. The CLI and scripts use an API key as a Bearer token.",
      },
      {
        type: 'code',
        code: `curl -H "Authorization: Bearer nav_<token>" http://localhost:4000/api/v1/auth/me

curl -X POST -H "Authorization: Bearer nav_<token>" -H "Content-Type: application/json" \\
  -d '{"instanceCount": 3}' http://localhost:4000/api/v1/services/<serviceId>/scale`,
      },
      {
        type: 'p',
        text: "Errors return the HTTP status with a body of `{ \"error\": { \"code\", \"message\" } }`. Lists return `{ \"items\": [...], \"nextCursor\": null }`, and you page with `cursor` and `limit`. Roles are owner, admin, developer and viewer. Viewers are read-only, and only admins and above manage members, domains and deletions.",
      },
      {
        type: 'list',
        items: [
          "Auth and keys: `/auth/signup`, `/auth/login`, `/auth/me`, `/api-keys`",
          "Workspaces: `/workspaces`, `/workspaces/:ws/members`, `/workspaces/:ws/projects`",
          "Services: `/workspaces/:ws/services`, `/services/:id`, with `deploys`, `scale`, `suspend`, `resume` and `restart` actions",
          "Deploys: `/services/:id/deploys`, `/deploys/:id/rollback`",
          "Environment: `/services/:id/env-vars` (`PUT` and `PATCH`), `/services/:id/secret-files`, `/env-groups/:id`",
          "Logs and metrics: `/services/:id/logs`, `/services/:id/logs/stream` (SSE), `/services/:id/metrics`",
          "Domains: `/services/:id/custom-domains`, `/custom-domains/:id/verify`",
          "Postgres: `/workspaces/:ws/databases`, `/databases/:id/backups`, `/databases/:id/query`",
          "Blueprints: `/workspaces/:ws/blueprints`, `/blueprints/validate`",
          "Live updates: `/workspaces/:ws/stream` (SSE)",
          "Hooks: `/webhooks/github` (signed) and `/deploy-hooks/:serviceId?key=`",
        ],
      },
    ],
  },
  {
    slug: 'security',
    group: 'Operate',
    title: 'Security',
    blocks: [
      { type: 'h3', text: 'Security model', id: 'security-model' },
      {
        type: 'list',
        items: [
          "Passwords are hashed with scrypt using a per-user salt.",
          "Sessions are random 32-byte tokens. Only their SHA-256 hash is stored.",
          "API keys start with `nav_`, are stored hashed and are shown once.",
          "Browser requests that change data need the SameSite=Lax session cookie and the custom CSRF header.",
          "Secrets at rest (environment variables, secret files, database passwords, TLS keys and GitHub tokens) are encrypted with AES-256-GCM under `NAV_MASTER_KEY`.",
          "GitHub webhooks are verified with HMAC SHA-256 using a constant-time comparison. Deploy hook keys are 32 random characters.",
          "Access is scoped per workspace with the owner, admin, developer and viewer roles. Every resource lookup goes through the caller's membership.",
          "Auth endpoints are rate limited, request bodies have size limits and inputs are validated with zod.",
          "Build and run sandboxes never receive platform variables, the database URL or the master key.",
          "Sign-in with GitHub, GitLab, Bitbucket, Google or SSO uses the authorization-code flow with a one-time state cookie, and PKCE everywhere except GitHub. A provider account is linked to an existing NAV account by email only when that account's address is verified, so nobody can pre-register your email and wait for you to sign in.",
          "Password reset links are single-use, stored hashed, expire after an hour and sign out every other session. The forgot-password endpoint gives the same answer whether or not the account exists.",
          "Two-factor authentication uses authenticator-app codes (each accepted once) with single-use recovery codes, and applies to password, provider and reset sign-ins. Workspaces can require it.",
          "Every change made through the API is written to the workspace audit log with the person or API key, the action and the IP address.",
        ],
      },
      { type: 'h3', text: 'Hardened containers', id: 'hardened-containers' },
      {
        type: 'p',
        text: "With the Docker driver every instance gets the plan's memory and CPU limits, a 512-process limit, all Linux capabilities dropped except the few a typical app needs, no-new-privileges, a private /tmp, no Docker socket, and its workspace's own network. Platform secrets are never passed in. Instance ports are published only on the node's private address; the edge is the only public way in.",
      },
      { type: 'h3', text: 'Verified webhooks', id: 'verified-webhooks' },
      {
        type: 'p',
        text: "Incoming GitHub webhooks are checked with HMAC SHA-256 in constant time before anything runs. Outgoing NAV webhooks are signed following the Standard Webhooks spec: verify `webhook-signature` as an HMAC SHA-256 of `<webhook-id>.<webhook-timestamp>.<body>` with your endpoint's `whsec_` secret, and reject old timestamps. Webhook and log-stream targets must be public addresses in production.",
      },
      {
        type: 'h3',
        text: 'Sign-in providers',
      },
      {
        type: 'p',
        text: "Each provider turns on when its client ID and secret are set. Register the callback URL `<NAV_API_PUBLIC_URL>/api/v1/auth/oauth/<provider>/callback` with GitLab, Bitbucket and Google, and `/api/v1/auth/github/callback` with GitHub. SSO works with any OpenID Connect identity provider for the email domains you list.",
      },
      {
        type: 'code',
        code: `NAV_GITHUB_CLIENT_ID=...       NAV_GITHUB_CLIENT_SECRET=...
NAV_GITLAB_CLIENT_ID=...       NAV_GITLAB_CLIENT_SECRET=...   # NAV_GITLAB_URL for self-managed GitLab
NAV_BITBUCKET_CLIENT_ID=...    NAV_BITBUCKET_CLIENT_SECRET=...
NAV_GOOGLE_CLIENT_ID=...       NAV_GOOGLE_CLIENT_SECRET=...
NAV_SSO_ISSUER=https://login.example.com
NAV_SSO_CLIENT_ID=...          NAV_SSO_CLIENT_SECRET=...
NAV_SSO_DOMAINS=example.com,example.org`,
      },
      {
        type: 'p',
        text: "NAV doesn't send email yet. Password reset links are written to the control plane log on a line starting with `[auth] password reset requested`, so an operator can pass them on.",
      },
      {
        type: 'p',
        text: "The process driver does not provide kernel-level isolation. Use the Docker driver for code you do not trust. Back up `NAV_MASTER_KEY`, because encrypted values cannot be read without it.",
      },
    ],
  },
  {
    slug: 'self-hosting',
    group: 'Operate',
    title: 'Self-hosting',
    blocks: [
      {
        type: 'p',
        text: "NAV runs as a control plane, a node agent and an edge, with PostgreSQL 17 as the platform database. Build the dashboard once and control serves the result from `apps/web/dist`.",
      },
      { type: 'h3', text: 'Architecture', id: 'architecture' },
      {
        type: 'p',
        text: "Every component talks through the platform database: work is a queue of jobs, routing is a view of healthy instances, and changes are announced with Postgres notifications. One control plane and edge serve any number of agent nodes.",
      },
      { type: 'h3', text: 'Control plane', id: 'control-plane' },
      {
        type: 'p',
        text: "Serves the REST API and the dashboard, runs the scheduler (cron, autoscaling, reconciliation, backups, failed-node detection), sends notifications and webhooks, holds the artifact store that moves builds between nodes, and issues TLS certificates.",
      },
      { type: 'h3', text: 'Agent', id: 'agent' },
      {
        type: 'p',
        text: "Runs on every server. It claims jobs, builds from Git, starts and supervises the instances placed on its node with the Docker or process driver, runs databases, Key Value and one-off jobs, and reports health and metrics. A node that stops heartbeating has its instances replaced on the others.",
      },
      { type: 'h3', text: 'Edge proxy', id: 'edge-proxy' },
      {
        type: 'p',
        text: "The only public entry point. It terminates TLS (with SNI per custom domain), routes each hostname to healthy instances with load balancing and retries, serves static sites, enforces inbound IP rules and maintenance mode, caches what apps mark cacheable, and records request metrics.",
      },
      { type: 'h3', text: 'Install' },
      {
        type: 'code',
        code: `npm install
npm run build -w @nav/web`,
      },
      {
        type: 'p',
        text: "For production, set these variables. Replace the example values with your own.",
      },
      {
        type: 'code',
        code: `NAV_DRIVER=docker
NAV_DATABASE_URL=postgres://nav:<password>@db.internal:5432/nav
NAV_MASTER_KEY=<64 hex characters>
NAV_APPS_DOMAIN=apps.example.com
NAV_EDGE_PUBLIC_IP=203.0.113.10
NAV_EDGE_HTTP_PORT=80
NAV_EDGE_HTTPS_PORT=443
NAV_PUBLIC_PORT_SUFFIX=
NAV_PUBLIC_SCHEME=https
NAV_ACME_EMAIL=ops@example.com
NAV_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory`,
      },
      {
        type: 'p',
        text: "For GitHub, create a GitHub App whose webhook points at `/api/v1/webhooks/github`, and an OAuth app, then set the `NAV_GITHUB_*` variables. The full list is in `packages/shared/src/config.ts`. Commit status is reported back to GitHub when the GitHub App is configured.",
      },
    ],
  },
  {
    slug: 'changelog',
    group: 'Reference',
    title: 'Changelog',
    blocks: [
      { type: 'h3', text: 'v0.1.0: initial release' },
      {
        type: 'list',
        items: [
          "Git-driven builds with runtime detection for Node, Bun, Python, Go, Ruby and static sites, plus Dockerfile and image services",
          "Zero-downtime deploys, rollbacks without rebuilding, deploy hooks, skip markers and build filters",
          "Web, private, worker, cron and static services, with manual and autoscaled instance counts",
          "Managed Postgres with a query console, backups and in-place restore on the process driver",
          "Environment variables, env groups and secret files, encrypted at rest",
          "Custom domains with ACME TLS and SNI routing",
          "Pull request preview environments",
          "Blueprints (nav.yaml) with validate, launch and sync",
          "Logs, metrics and events, with a REST API, a CLI and a dashboard",
          "Docker and process runtime drivers, role-based access and API keys",
        ],
      },
    ],
  },
  {
    slug: 'faq',
    group: 'Reference',
    title: 'FAQ',
    blocks: [
      { type: 'h3', text: 'Do I need Docker?' },
      {
        type: 'p',
        text: "No. Without Docker, NAV uses the process driver, which runs real builds and processes but has no container isolation. Use Docker for code you do not trust.",
      },
      { type: 'h3', text: 'Can NAV run across several machines?' },
      {
        type: 'p',
        text: "Not in practice yet. Process-driver artifacts live on one node, and the Docker driver would need an image registry before work could be spread across nodes.",
      },
      { type: 'h3', text: 'Which runtimes are detected?' },
      {
        type: 'p',
        text: "Node, Bun, Python, Go, Ruby and static sites are detected from the repository's files. A repository with a Dockerfile is built with it, and a `Procfile` `web:` line overrides the default start command.",
      },
      { type: 'h3', text: 'Does NAV spin idle services down?' },
      {
        type: 'p',
        text: "Only free web services: they sleep after 15 minutes without traffic and wake on the next request. See Scaling → Free instances.",
      },
      { type: 'h3', text: 'Can I use NAV without the dashboard?' },
      {
        type: 'p',
        text: "Yes. Create an API key in the dashboard and use the `nav` CLI or the REST API with it as a Bearer token.",
      },
      { type: 'h3', text: 'What is not built yet?' },
      {
        type: 'list',
        items: [
          "Multi-node scheduling. Deploys run on a single node in practice.",
          "Docker-driver Postgres backups and restores.",
          "Wildcard certificates, which need DNS-01 validation.",
          "Key Value (Redis) services.",
          "Persistent disk snapshots.",
          "SSH shell access to instances.",
          "Log streaming to syslog.",
          "Blueprint preview environments that spin up a whole stack. Per-service PR previews are built.",
        ],
      },
    ],
  },
];
