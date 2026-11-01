// Database row -> API wire shape (see packages/shared/src/index.ts).
import { config, publicUrlFor } from '@nav/shared/config';
import type { Row } from '../db/pool.ts';
import type {
  ApiKey, Blueprint, CustomDomain, Database, DbBackup, DbOperation, DbReplica, Deploy, Event, Instance, LogLine, Run, Service, WorkflowRun, WorkflowStep, WorkflowTask,
} from '@nav/shared';

export function workflowTask(r: Row): WorkflowTask {
  return {
    name: r.name,
    retries: r.retries,
    timeoutSeconds: Number(r.timeout_s),
    backoffSeconds: Number(r.backoff_s),
    maxBackoffSeconds: Number(r.max_backoff_s),
    description: r.description,
    deployId: r.deploy_id,
  };
}

export function workflowRun(r: Row): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.service_id,
    deployId: r.deploy_id,
    task: r.task,
    status: r.status,
    input: r.input ?? null,
    output: r.output ?? null,
    error: r.error,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    timeoutSeconds: Number(r.timeout_s),
    parentRunId: r.parent_run_id,
    rootRunId: r.root_run_id,
    depth: r.depth,
    idempotencyKey: r.idempotency_key,
    trigger: r.trigger,
    retryOf: r.retry_of,
    executions: r.executions ?? [],
    nextAttemptAt: r.next_attempt_at,
    wakeAt: r.wake_at,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function workflowStep(r: Row): WorkflowStep {
  return { seq: r.seq, kind: r.kind, task: r.task, childRunId: r.child_run_id, until: r.until };
}

export function service(r: Row): Service {
  const isPublic = r.type === 'web' || r.type === 'static';
  const hasPort = r.type === 'web' || r.type === 'private';
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    environmentId: r.environment_id,
    name: r.name,
    slug: r.slug,
    type: r.type,
    runtime: r.runtime,
    repoUrl: r.repo_url,
    branch: r.branch,
    rootDir: r.root_dir,
    imageUrl: r.image_url,
    buildCommand: r.build_command,
    startCommand: r.start_command,
    preDeployCommand: r.pre_deploy_command,
    dockerfilePath: r.dockerfile_path,
    dockerContext: r.docker_context,
    publishPath: r.publish_path,
    healthCheckPath: r.health_check_path,
    port: r.port,
    plan: r.plan,
    instanceCount: r.instance_count,
    autoscaling: r.autoscaling,
    autoDeploy: r.auto_deploy,
    buildFilter: r.build_filter,
    cronSchedule: r.cron_schedule,
    disk: r.disk,
    staticHeaders: r.static_headers,
    staticRoutes: r.static_routes,
    previews: r.previews,
    parentServiceId: r.parent_service_id,
    prNumber: r.pr_number,
    suspended: r.suspended,
    maintenanceMode: r.maintenance_mode,
    sleeping: r.sleeping ?? false,
    lastRequestAt: r.last_request_at ?? null,
    ipAllowList: r.ip_allow_list ?? [],
    edgeCache: r.edge_cache ?? { enabled: false },
    shutdownDelaySeconds: r.shutdown_delay_s ?? 30,
    registryCredentialId: r.registry_credential_id ?? null,
    status: r.status,
    currentDeployId: r.current_deploy_id,
    url: isPublic ? publicUrlFor(r.slug) : null,
    internalAddress: hasPort ? `${r.slug}:${r.port ?? 10000}` : null,
    deployHookUrl: `${config.apiPublicUrl}/api/v1/deploy-hooks/${r.id}?key=${r.deploy_hook_token}`,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function deploy(r: Row): Deploy {
  return {
    id: r.id,
    serviceId: r.service_id,
    status: r.status,
    trigger: r.trigger,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    commitAuthor: r.commit_author,
    branch: r.branch,
    clearCache: r.clear_cache,
    rollbackOf: r.rollback_of,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    buildFinishedAt: r.build_finished_at,
    finishedAt: r.finished_at,
  };
}

export function instance(r: Row): Instance {
  return {
    id: r.id,
    serviceId: r.service_id,
    deployId: r.deploy_id,
    nodeId: r.node_id,
    status: r.status,
    restartCount: r.restart_count,
    lastExitCode: r.last_exit_code,
    startedAt: r.started_at,
  };
}

export function logLine(r: Row): LogLine {
  return {
    id: r.id,
    serviceId: r.service_id,
    databaseId: r.database_id,
    deployId: r.deploy_id,
    instanceId: r.instance_id,
    runId: r.run_id,
    stream: r.stream,
    level: r.level,
    message: r.message,
    ts: r.ts,
  };
}

export function run(r: Row): Run {
  return {
    id: r.id,
    serviceId: r.service_id,
    kind: r.kind,
    command: r.command,
    status: r.status,
    trigger: r.trigger,
    exitCode: r.exit_code,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function domain(r: Row, serviceSlug: string): CustomDomain {
  const host = r.domain.replace(/^\*\./, '');
  const isApex = host.split('.').length === 2;
  return {
    id: r.id,
    serviceId: r.service_id,
    domain: r.domain,
    redirectTo: r.redirect_to,
    verificationStatus: r.verification_status,
    certStatus: r.cert_status,
    lastError: r.last_error,
    dnsRecordType: isApex ? 'A' : 'CNAME',
    dnsTarget: isApex ? config.edgePublicIp : `${serviceSlug}.${config.appsDomain}`,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
  };
}

export function database(r: Row): Database {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    environmentId: r.environment_id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    pgVersion: r.pg_version,
    dbName: r.db_name,
    dbUser: r.db_user,
    diskGB: r.disk_gb,
    status: r.status,
    internalUrl: r.status === 'available' ? `postgresql://${r.db_user}:********@${r.slug}:5432/${r.db_name}` : null,
    externalUrl: r.status === 'available' && r.port ? `postgresql://${r.db_user}:********@${config.edgePublicIp}:${r.port}/${r.db_name}` : null,
    ipAllowList: r.ip_allow_list,
    highAvailability: Boolean(r.high_availability),
    connectionPooling: Boolean(r.pooler_enabled),
    pooledExternalUrl: r.status === 'available' && r.pooler_enabled && r.pooler_port ? `postgresql://${r.db_user}:********@${config.edgePublicIp}:${r.pooler_port}/${r.db_name}` : null,
    recoveredFrom: r.recovered_from ?? null,
    createdAt: r.created_at,
  };
}

/** Lag fields come from the primary's pg_stat_replication (see GET /databases/:id/replicas). */
export function replica(r: Row, db: Row, live?: { state: string; lagBytes: number | null; lagSeconds: number | null }): DbReplica {
  return {
    id: r.id,
    databaseId: r.database_id,
    role: r.role,
    name: r.name,
    status: r.status,
    host: r.host,
    port: r.port,
    externalUrl: r.status === 'available' && r.port ? `postgresql://${db.db_user}:********@${config.edgePublicIp}:${r.port}/${db.db_name}` : null,
    state: r.status === 'available' ? live?.state ?? 'disconnected' : null,
    lagBytes: live?.lagBytes ?? null,
    lagSeconds: live?.lagSeconds ?? null,
    error: r.error,
    createdAt: r.created_at,
  };
}

export function dbOperation(r: Row): DbOperation {
  return { id: r.id, databaseId: r.database_id, kind: r.kind, status: r.status, data: r.data, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at };
}

export function backup(r: Row): DbBackup {
  return {
    id: r.id,
    databaseId: r.database_id,
    kind: r.kind,
    status: r.status,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function event(r: Row): Event {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    serviceId: r.service_id,
    databaseId: r.database_id,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? 'unknown' } : null,
    kind: r.kind,
    data: r.data,
    createdAt: r.created_at,
  };
}

export function apiKey(r: Row): ApiKey {
  return { id: r.id, name: r.name, prefix: r.prefix, lastUsedAt: r.last_used_at, createdAt: r.created_at };
}

export function blueprint(r: Row, resources: Row[]): Blueprint {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    repoUrl: r.repo_url,
    branch: r.branch,
    filePath: r.file_path,
    autoSync: r.auto_sync,
    status: r.status,
    lastError: r.last_error,
    lastSyncedAt: r.last_synced_at,
    resources: resources.map((x) => ({ type: x.resource_type, id: x.resource_id, name: x.name })),
    previews: r.previews ?? { generation: 'off', expireAfterDays: 7 },
    createdAt: r.created_at,
  };
}
