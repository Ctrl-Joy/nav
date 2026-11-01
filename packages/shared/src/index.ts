// Shared contract between the NAV control plane, dashboard, CLI and edge.
// Wire format: JSON, camelCase keys, ISO-8601 timestamps.

export type ServiceType = 'web' | 'private' | 'worker' | 'cron' | 'static' | 'workflow';
export type Runtime = 'auto' | 'node' | 'python' | 'go' | 'ruby' | 'bun' | 'docker' | 'image' | 'static';
export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export type DeployStatus =
  | 'queued' | 'build_in_progress' | 'pre_deploy_in_progress' | 'update_in_progress'
  | 'live' | 'deactivated' | 'build_failed' | 'pre_deploy_failed' | 'update_failed' | 'canceled';

export const DEPLOY_ACTIVE: DeployStatus[] = ['queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress'];
export const DEPLOY_FAILED: DeployStatus[] = ['build_failed', 'pre_deploy_failed', 'update_failed'];

export type DeployTrigger =
  | 'new_service' | 'git_push' | 'manual' | 'api' | 'rollback' | 'deploy_hook'
  | 'env_change' | 'blueprint' | 'preview' | 'config_change';

export type ServiceStatus = 'created' | 'deploying' | 'live' | 'failed' | 'suspended' | 'sleeping';

export interface Plan {
  id: string;
  name: string;
  cpu: number;        // vCPU
  memoryMB: number;
  priceMonthly: number;
  kind: 'service' | 'database';
}

export const SERVICE_PLANS: Plan[] = [
  { id: 'free', name: 'Free', cpu: 0.1, memoryMB: 512, priceMonthly: 0, kind: 'service' },
  { id: 'starter', name: 'Starter', cpu: 0.5, memoryMB: 512, priceMonthly: 7, kind: 'service' },
  { id: 'standard', name: 'Standard', cpu: 1, memoryMB: 2048, priceMonthly: 25, kind: 'service' },
  { id: 'pro', name: 'Pro', cpu: 2, memoryMB: 4096, priceMonthly: 85, kind: 'service' },
  { id: 'pro_plus', name: 'Pro Plus', cpu: 4, memoryMB: 8192, priceMonthly: 175, kind: 'service' },
];

export const DATABASE_PLANS: Plan[] = [
  { id: 'free', name: 'Free', cpu: 0.1, memoryMB: 256, priceMonthly: 0, kind: 'database' },
  { id: 'basic-256mb', name: 'Basic 256 MB', cpu: 0.1, memoryMB: 256, priceMonthly: 6, kind: 'database' },
  { id: 'basic-1gb', name: 'Basic 1 GB', cpu: 0.5, memoryMB: 1024, priceMonthly: 19, kind: 'database' },
  { id: 'pro-4gb', name: 'Pro 4 GB', cpu: 1, memoryMB: 4096, priceMonthly: 55, kind: 'database' },
  { id: 'pro-8gb', name: 'Pro 8 GB', cpu: 2, memoryMB: 8192, priceMonthly: 100, kind: 'database' },
];

/** Point-in-time recovery window per database plan, in days (0: free databases have no PITR). */
export function pitrRetentionDays(plan: string): number {
  if (plan === 'free') return 0;
  return plan.startsWith('pro') ? 7 : 3;
}

/** High availability (a hot standby with automatic failover) is offered on paid database plans. */
export const haAvailable = (plan: string): boolean => plan !== 'free';

/** Extensions users may CREATE / DROP themselves (postgis only when installed on the node). */
export const PG_EXTENSION_ALLOW_LIST = [
  'pgcrypto', 'uuid-ossp', 'citext', 'hstore', 'pg_trgm', 'btree_gin', 'btree_gist', 'unaccent', 'intarray',
  'tablefunc', 'fuzzystrmatch', 'ltree', 'cube', 'earthdistance', 'pg_stat_statements', 'postgis',
] as const;

/** Newest PostgreSQL major version NAV knows how to run. */
export const PG_LATEST_VERSION = 18;

/** Key Value (Redis-compatible) plans: memoryMB is the instance's maxmemory. */
export const KEY_VALUE_PLANS: Plan[] = [
  { id: 'free', name: 'Free', cpu: 0.1, memoryMB: 25, priceMonthly: 0, kind: 'database' },
  { id: 'starter', name: 'Starter', cpu: 0.25, memoryMB: 256, priceMonthly: 10, kind: 'database' },
  { id: 'standard', name: 'Standard', cpu: 0.5, memoryMB: 1024, priceMonthly: 32, kind: 'database' },
  { id: 'pro', name: 'Pro', cpu: 1, memoryMB: 5120, priceMonthly: 135, kind: 'database' },
  { id: 'pro-plus', name: 'Pro Plus', cpu: 2, memoryMB: 10240, priceMonthly: 250, kind: 'database' },
];

/** Usage estimates prorate monthly prices over this many hours (730, an average month). */
export const HOURS_PER_MONTH = 730;
/** Estimated price of persistent disk storage per GB-month. */
export const DISK_PRICE_GB_MONTH = 0.25;

/** GET /workspaces/:ws/usage?month=YYYY-MM. Costs are estimates from plan prices: NAV does not bill. */
export interface UsagePlanLine { plan: string; planName: string; hours: number; estimatedCost: number }
export interface UsageReport {
  month: string;                       // YYYY-MM (UTC)
  start: string;
  end: string;
  /** The month is still in progress: usage runs up to now. */
  partial: boolean;
  generatedAt: string;
  disclaimer: string;
  totals: {
    instanceHours: number;
    bandwidthBytes: number;
    buildMinutes: number;
    diskGBMonths: number;
    databaseHours: number;
    keyValueHours: number;
    estimatedCost: number;
  };
  instanceHoursByPlan: UsagePlanLine[];
  databaseHoursByPlan: UsagePlanLine[];
  keyValueHoursByPlan: UsagePlanLine[];
  services: {
    id: string; name: string; type: string | null; deleted: boolean;
    instanceHours: number; plans: UsagePlanLine[]; bandwidthBytes: number; buildMinutes: number; diskGBMonths: number; estimatedCost: number;
  }[];
  databases: { id: string; name: string; deleted: boolean; hours: number; plans: UsagePlanLine[]; storageGBMonths: number; estimatedCost: number }[];
  keyValues: { id: string; name: string; deleted: boolean; hours: number; plans: UsagePlanLine[]; estimatedCost: number }[];
  /** One entry per UTC day of the month (future days omitted). */
  daily: { day: string; instanceHours: number; bandwidthBytes: number }[];
}

export const KEY_VALUE_POLICIES =['allkeys-lru', 'noeviction', 'allkeys-lfu', 'volatile-lru', 'volatile-lfu', 'allkeys-random', 'volatile-random', 'volatile-ttl'] as const;

export interface User {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  /** False for accounts that only sign in through a provider. */
  hasPassword?: boolean;
  emailVerified?: boolean;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  environments: Environment[];
  createdAt: string;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  protected: boolean;
}

export interface Autoscaling {
  enabled: boolean;
  min: number;
  max: number;
  targetCpuPercent: number | null;
  targetMemoryPercent: number | null;
}

export interface Disk { name: string; mountPath: string; sizeGB: number }
export interface StaticHeader { path: string; name: string; value: string }
export interface StaticRoute { type: 'redirect' | 'rewrite'; source: string; destination: string }
export interface Previews { mode: 'off' | 'manual' | 'automatic'; expireAfterDays: number }
/** 'checks' deploys a pushed commit only after all of its GitHub checks / statuses pass. */
export type AutoDeploy = 'commit' | 'checks' | 'off';
/** Blueprint-level preview environments (a copy of the whole stack per pull request). */
export interface BlueprintPreviews { generation: 'off' | 'manual' | 'automatic'; expireAfterDays: number }

export interface Service {
  id: string;
  workspaceId: string;
  environmentId: string | null;
  name: string;
  slug: string;
  type: ServiceType;
  runtime: Runtime;
  repoUrl: string | null;
  branch: string | null;
  rootDir: string;
  imageUrl: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  preDeployCommand: string | null;
  dockerfilePath: string;
  dockerContext: string;
  publishPath: string | null;
  healthCheckPath: string | null;
  port: number | null;
  plan: string;
  instanceCount: number;
  autoscaling: Autoscaling;
  autoDeploy: AutoDeploy;
  buildFilter: { paths: string[]; ignoredPaths: string[] };
  cronSchedule: string | null;
  disk: Disk | null;
  staticHeaders: StaticHeader[];
  staticRoutes: StaticRoute[];
  previews: Previews;
  parentServiceId: string | null;
  prNumber: number | null;
  suspended: boolean;
  maintenanceMode: boolean;
  /** Free web service spun down for inactivity; the next request wakes it. */
  sleeping: boolean;
  lastRequestAt: string | null;   // latest inbound HTTP request seen by the edge (batched, ~10 s granularity)
  ipAllowList: { cidr: string; description: string }[];
  edgeCache: { enabled: boolean; maxTtlSeconds?: number };
  shutdownDelaySeconds: number;
  registryCredentialId: string | null;
  status: ServiceStatus;
  currentDeployId: string | null;
  url: string | null;              // public URL (web/static) e.g. http://my-app.nav.localhost:7080
  internalAddress: string | null;  // host:port on the private network (web/private)
  deployHookUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface Deploy {
  id: string;
  serviceId: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  clearCache: boolean;
  rollbackOf: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  buildFinishedAt: string | null;
  finishedAt: string | null;
}

export interface Instance {
  id: string;
  serviceId: string;
  deployId: string;
  nodeId: string;
  status: 'pending' | 'starting' | 'healthy' | 'unhealthy' | 'draining' | 'stopped' | 'crashed' | 'lost';
  restartCount: number;
  lastExitCode: number | null;
  startedAt: string;
}

export interface EnvVar { key: string; value: string }
export interface SecretFile { filename: string; content: string }

export interface EnvGroup {
  id: string;
  workspaceId: string;
  name: string;
  envVars: EnvVar[];
  secretFiles: SecretFile[];
  serviceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LogLine {
  id: number;
  serviceId: string | null;
  databaseId: string | null;
  deployId: string | null;
  instanceId: string | null;
  runId: string | null;
  stream: 'build' | 'deploy' | 'runtime' | 'cron' | 'job' | 'system' | 'workflow';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  ts: string;
}

export interface MetricsResponse {
  // each series: [isoTimestamp, value]
  cpu: [string, number][];            // cores used (sum across instances)
  cpuLimit: number;                   // cores per instance * instances
  memoryMB: [string, number][];
  memoryLimitMB: number;
  instances: [string, number][];
  requests: [string, number][];        // per minute
  errors5xx: [string, number][];
  latencyAvgMs: [string, number][];
  bandwidthBytes: [string, number][];
}

export interface Run {
  id: string;
  serviceId: string;
  kind: 'cron' | 'job';
  command: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  trigger: string;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// Workflows ------------------------------------------------------------------

export type WorkflowRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';
export const WORKFLOW_RUN_ACTIVE: WorkflowRunStatus[] = ['queued', 'running', 'waiting'];
export const WORKFLOW_RUN_TERMINAL: WorkflowRunStatus[] = ['succeeded', 'failed', 'canceled'];

/** A task registered by the workflow's code, as reported by the live deploy's "describe" run. */
export interface WorkflowTask {
  name: string;
  retries: number;
  timeoutSeconds: number;
  backoffSeconds: number;
  maxBackoffSeconds: number;
  description: string | null;
  deployId: string;
}

/** A workflow service plus its workflow-specific state. */
export interface Workflow {
  service: Service;
  maxConcurrency: number;
  tasks: WorkflowTask[];
  counts: Record<WorkflowRunStatus, number>;
}

/** One execution of the task code: the first start of an attempt, or a resume after subtasks / a sleep. */
export interface WorkflowExecution {
  attempt: number;
  kind: 'start' | 'resume';
  startedAt: string;
  finishedAt: string | null;
  outcome: 'succeeded' | 'failed' | 'suspended' | 'timed_out' | 'canceled' | null;
  error: string | null;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  deployId: string | null;
  task: string;
  status: WorkflowRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  timeoutSeconds: number;
  parentRunId: string | null;
  rootRunId: string | null;
  depth: number;
  idempotencyKey: string | null;
  trigger: string;
  retryOf: string | null;
  executions: WorkflowExecution[];
  nextAttemptAt: string | null;
  wakeAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A replay-journal entry: a ctx.run (child run) or ctx.sleep the run reached. */
export interface WorkflowStep {
  seq: number;
  kind: 'run' | 'sleep';
  task: string | null;
  childRunId: string | null;
  until: string | null;
}

export interface WorkflowRunDetail {
  run: WorkflowRun;
  steps: WorkflowStep[];
  /** Every run in the same tree (the root and all its descendants), oldest first. */
  tree: WorkflowRun[];
}

export interface CustomDomain {
  id: string;
  serviceId: string;
  domain: string;
  redirectTo: string | null;
  verificationStatus: 'unverified' | 'verified' | 'failed';
  certStatus: 'pending' | 'issuing' | 'issued' | 'failed';
  lastError: string | null;
  dnsTarget: string;                   // what the CNAME / A record must point to
  dnsRecordType: 'CNAME' | 'A';
  verifiedAt: string | null;
  createdAt: string;
}

export interface Database {
  id: string;
  workspaceId: string;
  environmentId: string | null;
  name: string;
  slug: string;
  plan: string;
  pgVersion: number;
  dbName: string;
  dbUser: string;
  diskGB: number;
  status: 'creating' | 'available' | 'suspended' | 'failed' | 'deleting' | 'restoring' | 'upgrading';
  internalUrl: string | null;          // revealed only via GET /databases/:id/credentials
  externalUrl: string | null;
  ipAllowList: { cidr: string; description: string }[];
  /** A hot standby is kept in sync and promoted automatically if the primary stops responding. */
  highAvailability: boolean;
  /** PgBouncer runs in front of the database (transaction pooling). */
  connectionPooling: boolean;
  pooledExternalUrl: string | null;    // masked like externalUrl
  /** Set on databases created by "Recover to a point in time". */
  recoveredFrom: { databaseId: string; targetTime: string } | null;
  createdAt: string;
}

export interface DatabaseCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  internalUrl: string;
  externalUrl: string;
  psqlCommand: string;
  /** Through PgBouncer (transaction pooling), when connection pooling is enabled. */
  pooledInternalUrl?: string | null;
  pooledExternalUrl?: string | null;
  /** Read-only connection strings of the read replicas. */
  replicas?: { id: string; name: string; host: string; port: number; internalUrl: string; externalUrl: string }[];
}

export interface DbBackup {
  id: string;
  databaseId: string;
  kind: 'automatic' | 'manual';
  status: 'pending' | 'running' | 'completed' | 'failed';
  sizeBytes: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** GET /databases/:id/recovery — the point-in-time recovery window. */
export interface DbRecoveryWindow {
  enabled: boolean;
  retentionDays: number;
  /** Earliest / latest restorable instants (null when nothing is restorable yet). */
  earliest: string | null;
  latest: string | null;
  /** Why recovery is unavailable, e.g. free plan or no base backup yet. */
  reason: string | null;
  lastArchivedAt: string | null;
}

export interface DbReplica {
  id: string;
  databaseId: string;
  role: 'replica' | 'standby';
  name: string;
  status: 'creating' | 'available' | 'failed' | 'deleting';
  host: string | null;
  port: number | null;
  externalUrl: string | null;          // masked; full URL via /credentials
  /** Streaming state seen from the primary: streaming, catchup, disconnected. */
  state: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  error: string | null;
  createdAt: string;
}

export interface DbPooler {
  enabled: boolean;
  /** False when the node cannot run PgBouncer (install it, or use the docker driver). */
  available: boolean;
  mode: 'transaction';
  port: number | null;
  pooledExternalUrl: string | null;    // masked
  reason: string | null;
}

export interface DbExtension {
  name: string;
  defaultVersion: string | null;
  installedVersion: string | null;
  comment: string | null;
  /** pg_stat_statements must be preloaded; false until the database restarts with it. */
  ready: boolean;
}

export interface DbOperation {
  id: string;
  databaseId: string;
  kind: 'upgrade' | 'repack' | 'recover' | 'failover';
  status: 'pending' | 'running' | 'completed' | 'failed';
  data: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DbUpgradeInfo {
  currentVersion: number;
  /** Major versions this database can be upgraded to on its node, with the method that would be used. */
  targets: { version: number; method: 'pg_upgrade' | 'dump_restore' }[];
  reason: string | null;
}

export interface DbSlowQuery {
  queryId: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  cacheHitRatio: number | null;
}

export interface DbTableStat {
  schema: string;
  table: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  liveTuples: number;
  deadTuples: number;
  /** Estimated reclaimable space (heuristic from row width and tuple count). */
  bloatBytes: number | null;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
}

export interface Blueprint {
  id: string;
  workspaceId: string;
  name: string;
  repoUrl: string;
  branch: string;
  filePath: string;
  autoSync: boolean;
  status: 'pending' | 'syncing' | 'in_sync' | 'error';
  lastError: string | null;
  lastSyncedAt: string | null;
  resources: { type: 'service' | 'database' | 'env_group'; id: string; name: string }[];
  previews: BlueprintPreviews;
  createdAt: string;
}

/** A pull request's copy of a blueprint's whole stack. */
export interface PreviewEnvironment {
  id: string;
  blueprintId: string;
  prNumber: number;
  prTitle: string | null;
  branch: string;
  commitSha: string | null;
  status: 'creating' | 'ready' | 'failed' | 'deleting';
  error: string | null;
  resources: { type: 'service' | 'database' | 'env_group'; id: string; name: string; status: string | null; url: string | null }[];
  createdAt: string;
  updatedAt: string;
}

/** What "Deploy to NAV" found in a repository's blueprint file. */
export interface BlueprintInspection {
  valid: boolean;
  errors: string[];
  repoUrl: string;
  branch: string;
  filePath: string;
  name: string;
  yaml: string;
  services: { name: string; type: string; runtime: string; plan: string | null }[];
  databases: { name: string; plan: string | null }[];
  envGroups: { name: string }[];
  previews: BlueprintPreviews | null;
}

export interface Event {
  id: number;
  workspaceId: string;
  serviceId: string | null;
  databaseId: string | null;
  actor: { id: string; name: string } | null;
  kind: string;                         // e.g. deploy_started, deploy_live, deploy_failed, service_created, scaled, env_updated, domain_added, rollback, suspended, resumed
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ApiKey { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }

export interface Repo { fullName: string; cloneUrl: string; defaultBranch: string; private: boolean; installationId: number | null }

export interface ApiError { error: { code: string; message: string; details?: unknown } }

export interface Page<T> { items: T[]; nextCursor: string | null }

// Input shapes ---------------------------------------------------------------

export interface CreateServiceInput {
  name: string;
  type: ServiceType;
  environmentId?: string | null;
  runtime?: Runtime;
  repoUrl?: string | null;
  branch?: string | null;
  rootDir?: string;
  imageUrl?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  preDeployCommand?: string | null;
  dockerfilePath?: string;
  dockerContext?: string;
  publishPath?: string | null;
  healthCheckPath?: string | null;
  port?: number | null;
  plan?: string;
  instanceCount?: number;
  autoDeploy?: AutoDeploy;
  cronSchedule?: string | null;
  envVars?: EnvVar[];
  secretFiles?: SecretFile[];
  envGroupIds?: string[];
  disk?: Disk | null;
  previews?: Previews;
}

export type UpdateServiceInput = Partial<Omit<CreateServiceInput, 'type' | 'envVars' | 'secretFiles' | 'envGroupIds'>> & {
  autoscaling?: Autoscaling;
  buildFilter?: { paths: string[]; ignoredPaths: string[] };
  staticHeaders?: StaticHeader[];
  staticRoutes?: StaticRoute[];
  maintenanceMode?: boolean;
};

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'service';
}

// --- Sandboxes: short-lived, isolated environments for running untrusted code through the API ---------------

export type SandboxRuntime = 'node' | 'python' | 'bash';
export type SandboxNetworkAccess = 'none' | 'egress';
export type SandboxStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'expired' | 'failed';

export interface SandboxPlan { id: string; name: string; cpu: number; memoryMB: number; diskMB: number; pids: number }

export const SANDBOX_PLANS: SandboxPlan[] = [
  { id: 'small', name: 'Small', cpu: 0.5, memoryMB: 512, diskMB: 1024, pids: 128 },
  { id: 'medium', name: 'Medium', cpu: 1, memoryMB: 2048, diskMB: 4096, pids: 256 },
  { id: 'large', name: 'Large', cpu: 2, memoryMB: 4096, diskMB: 10240, pids: 512 },
];

/** Default image per runtime (docker driver). The process driver uses the host's own interpreters. */
export const SANDBOX_IMAGES: Record<SandboxRuntime, string> = {
  node: 'node:22-bookworm-slim',
  python: 'python:3.13-slim',
  bash: 'debian:bookworm-slim',
};

/** Hard limits, enforced by the control plane (and again by the agent where they bound resource use). */
export const SANDBOX_LIMITS = {
  minTtlSeconds: 60,
  defaultTtlSeconds: 15 * 60,
  maxTtlSeconds: 24 * 3600,
  /** Live sandboxes per workspace (workspaces.sandbox_limit overrides it). */
  maxPerWorkspace: 10,
  maxSnapshotsPerWorkspace: 50,
  defaultExecTimeoutSeconds: 60,
  maxExecTimeoutSeconds: 3600,
  /** Captured per stream by the synchronous exec endpoint; the rest is dropped and flagged as truncated. */
  maxOutputBytes: 1024 * 1024,
  maxCommandBytes: 64 * 1024,
  maxStdinBytes: 1024 * 1024,
  maxEnvVars: 100,
  maxFileBytes: 50 * 1024 * 1024,
  maxListEntries: 1000,
  /** Concurrent commands inside one sandbox (sync and streaming together). */
  maxConcurrentExecs: 8,
} as const;

export interface Sandbox {
  id: string;
  workspaceId: string;
  name: string | null;
  runtime: SandboxRuntime | null;
  image: string;
  plan: string;
  networkAccess: SandboxNetworkAccess;
  status: SandboxStatus;
  driver: 'process' | 'docker' | null;
  /** False on the process driver: commands run as plain host processes (development only). */
  isolated: boolean;
  /** True when the sandbox cannot reach private networks or its node: no network, or egress behind host firewall rules. */
  egressFiltered: boolean;
  nodeId: string | null;
  envKeys: string[];
  fromSnapshotId: string | null;
  ttlSeconds: number;
  expiresAt: string;
  execCount: number;
  lastExecAt: string | null;
  error: string | null;
  createdAt: string;
  stoppedAt: string | null;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxFileEntry { name: string; path: string; type: 'file' | 'dir' | 'symlink' | 'other'; size: number; modifiedAt: string }

export interface SandboxSnapshot {
  id: string;
  workspaceId: string;
  sandboxId: string | null;
  name: string | null;
  runtime: SandboxRuntime | null;
  image: string;
  status: 'pending' | 'completed' | 'failed';
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
