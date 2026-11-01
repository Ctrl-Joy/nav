// Shared contract between the NAV control plane, dashboard, CLI and edge.
// Wire format: JSON, camelCase keys, ISO-8601 timestamps.

export type ServiceType = 'web' | 'private' | 'worker' | 'cron' | 'static';
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
  autoDeploy: 'commit' | 'off';
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
  stream: 'build' | 'deploy' | 'runtime' | 'cron' | 'job' | 'system';
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
  status: 'creating' | 'available' | 'suspended' | 'failed' | 'deleting' | 'restoring';
  internalUrl: string | null;          // revealed only via GET /databases/:id/credentials
  externalUrl: string | null;
  ipAllowList: { cidr: string; description: string }[];
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
  createdAt: string;
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
  autoDeploy?: 'commit' | 'off';
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
