// Service creation/validation shared by the REST API, blueprint sync and PR previews.
import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { id } from '@nav/shared/ids';
import { SERVICE_PLANS, slugify, type CreateServiceInput, type Disk } from '@nav/shared';
import { config } from '@nav/shared/config';
import { notify, one, q, tx, type Row } from '../db/pool.ts';
import { HttpError, badRequest, changed, recordEvent } from './core.ts';
import { listEnv, listFiles, replaceEnv, replaceFiles } from './env.ts';
import { installationFor, lsRemote, validateRepoUrl } from './git.ts';
import { createDeploy } from './deploys.ts';

export function validateCron(expr: string): void {
  try {
    CronExpressionParser.parse(expr, { tz: 'UTC' });
  } catch {
    throw badRequest(`invalid cron schedule "${expr}"`);
  }
  if (expr.trim().split(/\s+/).length !== 5) throw badRequest('cron schedule must have 5 fields (minute hour day month weekday)');
}

export function validatePlan(plan: string, instanceCount: number, disk: Disk | null | undefined): void {
  if (!SERVICE_PLANS.some((p) => p.id === plan)) throw badRequest(`unknown plan "${plan}"`);
  if (plan === 'free' && instanceCount > 1) throw badRequest('free instances cannot be scaled beyond one instance');
  if (disk && instanceCount > 1) throw badRequest('services with a persistent disk are limited to one instance');
  if (disk && plan === 'free') throw badRequest('free instances cannot attach persistent disks');
}

export function validateDisk(disk: Disk | null | undefined): void {
  if (!disk) return;
  if (!/^\/[A-Za-z0-9_./-]*$/.test(disk.mountPath) || disk.mountPath.includes('..')) throw badRequest('disk mountPath must be an absolute path');
  if (['/', '/etc', '/usr', '/bin', '/proc', '/sys', '/dev'].includes(disk.mountPath)) throw badRequest('disk cannot be mounted over a system directory');
  if (disk.sizeGB < 1 || disk.sizeGB > 1024) throw badRequest('disk size must be between 1 and 1024 GB');
}

/** Labels under the apps domain that belong to the platform (the dashboard host), never to a service. */
export function reservedSlugs(): Set<string> {
  const out = new Set<string>();
  const suffix = `.${config.appsDomain}`;
  if (config.dashboardHost.endsWith(suffix)) out.add(config.dashboardHost.slice(0, -suffix.length));
  return out;
}

export async function uniqueServiceSlug(name: string): Promise<string> {
  const base = slugify(name);
  const reserved = reservedSlugs();
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    if (reserved.has(candidate)) continue;
    const taken = (await one('SELECT 1 FROM services WHERE slug = $1 UNION ALL SELECT 1 FROM databases WHERE slug = $1', [candidate])) !== null;
    if (!taken) return candidate;
  }
  throw new Error('could not allocate a service slug');
}

export interface CreateOptions {
  workspaceId: string;
  actorId: string | null;
  input: CreateServiceInput;
  parentServiceId?: string | null;
  prNumber?: number | null;
  trigger?: 'new_service' | 'blueprint' | 'preview';
  deploy?: boolean;
}

export async function createService(opts: CreateOptions): Promise<{ service: Row; deploy: Row | null }> {
  const i = opts.input;
  const type = i.type;
  const runtime = i.runtime ?? (i.imageUrl ? 'image' : 'auto');
  const instanceCount = i.instanceCount ?? 1;
  const plan = i.plan ?? (type === 'static' ? 'free' : 'starter');

  if (type !== 'static') validatePlan(plan, instanceCount, i.disk);
  validateDisk(i.disk);
  if (runtime === 'image') {
    if (!i.imageUrl || !/^[a-z0-9]+([._/:@-][a-zA-Z0-9]+)*$/.test(i.imageUrl)) throw badRequest('a valid imageUrl is required for image-backed services');
  } else if (!i.repoUrl) {
    throw badRequest('repoUrl is required');
  }
  if (type === 'cron') {
    if (!i.cronSchedule) throw badRequest('cronSchedule is required for cron jobs');
    validateCron(i.cronSchedule);
    if (!i.startCommand && runtime !== 'image' && runtime !== 'docker') throw badRequest('a command (startCommand) is required for cron jobs');
  }
  if (type === 'workflow' && i.disk) throw badRequest('workflows cannot attach a persistent disk (each run is a fresh one-off process)');
  if (i.port != null && (i.port < 1 || i.port > 65535 || [18012, 18013, 19099].includes(i.port))) throw badRequest('invalid or reserved port');
  if (i.healthCheckPath && !i.healthCheckPath.startsWith('/')) throw badRequest('healthCheckPath must start with /');
  if (i.rootDir && (i.rootDir.includes('..') || /^[/\\]/.test(i.rootDir))) throw badRequest('rootDir must be a relative path inside the repository');

  let repoUrl: string | null = null;
  let branch: string | null = i.branch ?? null;
  let installationId: number | null = null;
  if (i.repoUrl) {
    repoUrl = validateRepoUrl(i.repoUrl);
    installationId = await installationFor(opts.workspaceId, repoUrl);
    if (!branch) {
      const info = await lsRemote(repoUrl, installationId);
      branch = info.defaultBranch ?? info.branches[0] ?? 'main';
    }
  }

  if (i.environmentId) {
    const env = await one('SELECT 1 FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.id = $1 AND p.workspace_id = $2', [i.environmentId, opts.workspaceId]);
    if (!env) throw badRequest('environment not found in this workspace');
  }
  const groupIds = i.envGroupIds ?? [];
  if (groupIds.length) {
    const found = await q('SELECT id FROM env_groups WHERE workspace_id = $1 AND id = ANY($2)', [opts.workspaceId, groupIds]);
    if (found.length !== new Set(groupIds).size) throw badRequest('one or more env groups were not found');
  }

  const serviceId = id('srv');
  const slug = await uniqueServiceSlug(i.name);
  const svc = await tx(async (c) => {
    const res = await c.query(
      `INSERT INTO services (id, workspace_id, environment_id, name, slug, type, runtime, repo_url, branch, root_dir, installation_id, image_url,
         build_command, start_command, pre_deploy_command, dockerfile_path, docker_context, publish_path, health_check_path, port, plan,
         instance_count, auto_deploy, cron_schedule, disk, previews, parent_service_id, pr_number, deploy_hook_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
      [serviceId, opts.workspaceId, i.environmentId ?? null, i.name.trim(), slug, type, runtime, repoUrl, branch, (i.rootDir ?? '').replace(/^\.\/?/, '').replace(/\/$/, ''),
        installationId, i.imageUrl ?? null, i.buildCommand || null, i.startCommand || null, i.preDeployCommand || null, i.dockerfilePath ?? 'Dockerfile',
        i.dockerContext ?? '.', i.publishPath || null, type === 'web' ? i.healthCheckPath || null : null, i.port ?? null, plan,
        type === 'cron' || type === 'workflow' ? 1 : instanceCount, i.autoDeploy ?? 'commit', type === 'cron' ? i.cronSchedule : null, i.disk ?? null,
        i.previews ?? { mode: 'off', expireAfterDays: 7 }, opts.parentServiceId ?? null, opts.prNumber ?? null, randomBytes(16).toString('hex')],
    );
    await replaceEnv(c, 'service', serviceId, i.envVars ?? []);
    await replaceFiles(c, 'service', serviceId, i.secretFiles ?? []);
    for (const g of new Set(groupIds)) await c.query('INSERT INTO service_env_groups (service_id, group_id) VALUES ($1,$2)', [serviceId, g]);
    return res.rows[0];
  });

  await recordEvent({ workspaceId: opts.workspaceId, serviceId, actorId: opts.actorId, kind: 'service_created', data: { name: svc.name, type } });
  await changed(opts.workspaceId, 'service', serviceId, serviceId);
  const deploy = opts.deploy === false ? null : await createDeploy(svc, { trigger: opts.trigger ?? 'new_service', actorId: opts.actorId });
  return { service: svc, deploy };
}

/**
 * Null when `p` is a plain path relative to the repository (Dockerfile path, Docker context), otherwise why not:
 * no absolute or drive paths, no backslashes, no `..` segments. The build checks the resolved path again.
 */
export function repoPathError(p: string): string | null {
  if (!p.trim()) return 'must not be empty';
  if (p.includes('\0') || p.includes('\\')) return 'must not contain backslashes or NUL';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return 'must be relative to the repository';
  if (p.split('/').some((s) => s === '..')) return 'must not contain ".."';
  return null;
}

/**
 * Clone a service for a pull request / branch preview. Idempotent per (parent, pr). An untrusted preview (a pull
 * request from a fork) starts with an empty environment: none of the parent's env vars, secret files or env
 * groups, only IS_PULL_REQUEST and the NAV_* variables every deploy gets.
 */
export async function createPreview(parent: Row, branch: string, prNumber: number | null, actorId: string | null, sha?: string, opts: { untrusted?: boolean } = {}): Promise<{ service: Row; deploy: Row | null }> {
  if (prNumber) {
    const existing = await one('SELECT * FROM services WHERE parent_service_id = $1 AND pr_number = $2', [parent.id, prNumber]);
    if (existing) {
      // A preview made for a same-repository PR never turns into a fork's (a PR's head repository cannot change),
      // but be safe: untrusted code never deploys into a service that holds the parent's secrets.
      if (opts.untrusted && !existing.untrusted) throw new HttpError(409, 'preview_untrusted', 'this preview holds the parent service\'s secrets and cannot run code from a fork');
      const deploy = await createDeploy(existing, { trigger: 'preview', actorId, commitSha: sha ?? null });
      return { service: existing, deploy };
    }
  }
  const envVars = opts.untrusted ? [] : await listEnv('service', parent.id);
  envVars.push({ key: 'IS_PULL_REQUEST', value: 'true' });
  const groups = opts.untrusted ? [] : await q('SELECT group_id FROM service_env_groups WHERE service_id = $1', [parent.id]);
  const suffix = prNumber ? `pr-${prNumber}` : slugify(branch).slice(0, 20);
  const res = await createService({
    workspaceId: parent.workspace_id,
    actorId,
    parentServiceId: parent.id,
    prNumber,
    trigger: 'preview',
    deploy: false,
    input: {
      name: `${parent.name}-${suffix}`,
      type: parent.type,
      environmentId: parent.environment_id,
      runtime: parent.runtime,
      repoUrl: parent.repo_url,
      branch,
      rootDir: parent.root_dir,
      imageUrl: parent.image_url,
      buildCommand: parent.build_command,
      startCommand: parent.start_command,
      preDeployCommand: parent.pre_deploy_command,
      dockerfilePath: parent.dockerfile_path,
      dockerContext: parent.docker_context,
      publishPath: parent.publish_path,
      healthCheckPath: parent.health_check_path,
      port: parent.port,
      plan: parent.plan === 'free' ? 'free' : 'starter',
      instanceCount: 1,
      autoDeploy: 'commit',
      envVars,
      secretFiles: opts.untrusted ? [] : await listFiles('service', parent.id),
      envGroupIds: groups.map((g) => g.group_id),
    },
  });
  const svc = (await one(
    'UPDATE services SET static_routes = $2, static_headers = $3, untrusted = $4 WHERE id = $1 RETURNING *',
    [res.service.id, JSON.stringify(parent.static_routes), JSON.stringify(parent.static_headers), !!opts.untrusted],
  ))!;
  const deploy = await createDeploy(svc, { trigger: 'preview', actorId, commitSha: sha ?? null });
  return { service: svc, deploy };
}

export async function markForDeletion(svc: Row, actorId: string | null): Promise<void> {
  const children = await q("SELECT * FROM services WHERE parent_service_id = $1 AND status <> 'deleting'", [svc.id]);
  for (const child of [...children, svc]) {
    await q("UPDATE services SET status = 'deleting', suspended = true, updated_at = now() WHERE id = $1", [child.id]);
    await q("UPDATE deploys SET status = 'canceled', finished_at = now() WHERE service_id = $1 AND status = 'queued'", [child.id]);
    await q("INSERT INTO jobs (kind, payload, concurrency_key) VALUES ('delete_service', $1, $2)", [{ serviceId: child.id }, `svc:${child.id}`]);
    await recordEvent({ workspaceId: child.workspace_id, actorId, kind: 'service_deleted', data: { serviceId: child.id, name: child.name } });
  }
  await notify('nav_routes');
}
