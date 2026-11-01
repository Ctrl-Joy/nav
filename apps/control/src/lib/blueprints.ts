// Infrastructure-as-code: parse nav.yaml, compute a plan against current state, and apply it.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { CreateServiceInput, EnvVar } from '@nav/shared';
import { one, q, tx, type Row } from '../db/pool.ts';
import { badRequest, changed, enqueue, recordEvent } from './core.ts';
import { listEnv, patchEnv, replaceEnv } from './env.ts';
import { authedUrl, git } from './git.ts';
import { createService, markForDeletion, validateCron } from './services.ts';
import { createDatabase, credentials } from '../http/routes/databases.ts';
import { createDeploy } from './deploys.ts';


const EnvEntry = z.union([
  z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).transform(String) }),
  z.object({ key: z.string(), generateValue: z.literal(true) }),
  z.object({ key: z.string(), sync: z.literal(false) }),
  z.object({ key: z.string(), fromDatabase: z.object({ name: z.string(), property: z.enum(['connectionString', 'host', 'port', 'user', 'password', 'database']) }) }),
  z.object({ key: z.string(), fromService: z.object({ name: z.string(), type: z.string().optional(), property: z.enum(['host', 'port', 'hostport']) }) }),
  z.object({ fromGroup: z.string() }),
]);

const ServiceSpec = z.object({
  type: z.enum(['web', 'private', 'pserv', 'worker', 'cron', 'static', 'workflow']).transform((t) => (t === 'pserv' ? 'private' : t) as 'web' | 'private' | 'worker' | 'cron' | 'static' | 'workflow'),
  name: z.string().min(1).max(64),
  runtime: z.enum(['auto', 'node', 'python', 'go', 'ruby', 'bun', 'docker', 'image', 'static']).optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  rootDir: z.string().optional(),
  image: z.object({ url: z.string() }).optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  preDeployCommand: z.string().optional(),
  dockerfilePath: z.string().optional(),
  dockerContext: z.string().optional(),
  healthCheckPath: z.string().optional(),
  plan: z.string().optional(),
  numInstances: z.number().int().min(1).max(100).optional(),
  autoscaling: z.object({ min: z.number().int(), max: z.number().int(), targetCPUPercent: z.number().int().optional(), targetMemoryPercent: z.number().int().optional() }).optional(),
  schedule: z.string().optional(),
  staticPublishPath: z.string().optional(),
  autoDeploy: z.boolean().optional(),
  /** Deploy on every commit, only after CI checks pass, or never. */
  autoDeployTrigger: z.enum(['commit', 'checksPass', 'off']).optional(),
  disk: z.object({ name: z.string(), mountPath: z.string(), sizeGB: z.number().int().default(1) }).optional(),
  envVars: z.array(EnvEntry).optional(),
  routes: z.array(z.object({ type: z.enum(['redirect', 'rewrite']), source: z.string(), destination: z.string() })).optional(),
  headers: z.array(z.object({ path: z.string(), name: z.string(), value: z.string() })).optional(),
  previews: z.object({ generation: z.enum(['off', 'manual', 'automatic']).optional(), expireAfterDays: z.number().int().optional() }).optional(),
});

export const BlueprintSpec = z.object({
  services: z.array(ServiceSpec).default([]),
  databases: z.array(z.object({
    name: z.string().min(1).max(64),
    plan: z.string().optional(),
    postgresMajorVersion: z.union([z.number(), z.string()]).transform(Number).optional(),
    databaseName: z.string().optional(),
    user: z.string().optional(),
    diskSizeGB: z.number().int().optional(),
    ipAllowList: z.array(z.object({ source: z.string(), description: z.string().default('') })).optional(),
  })).default([]),
  envVarGroups: z.array(z.object({ name: z.string().min(1), envVars: z.array(EnvEntry).default([]) })).default([]),
  /** Preview environments: a copy of the whole stack per pull request against the blueprint's branch. */
  previews: z.object({ generation: z.enum(['off', 'manual', 'automatic']).default('off'), expireAfterDays: z.number().int().min(0).max(365).default(7) }).optional(),
});
export type BlueprintSpec = z.infer<typeof BlueprintSpec>;

export function parseBlueprint(text: string): BlueprintSpec {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw badRequest(`YAML syntax error: ${(err as Error).message}`);
  }
  const res = BlueprintSpec.safeParse(doc ?? {});
  if (!res.success) {
    const i = res.error.issues[0];
    throw badRequest(`${i.path.join('.')}: ${i.message}`, res.error.issues);
  }
  const spec = res.data;
  const names = new Set<string>();
  for (const s of spec.services) {
    if (names.has(s.name)) throw badRequest(`duplicate service name "${s.name}"`);
    names.add(s.name);
    if (s.type === 'cron') {
      if (!s.schedule) throw badRequest(`cron job "${s.name}" requires a schedule`);
      validateCron(s.schedule);
    }
    for (const e of s.envVars ?? []) {
      if ('fromDatabase' in e && !spec.databases.some((d) => d.name === e.fromDatabase.name)) throw badRequest(`service "${s.name}" references unknown database "${e.fromDatabase.name}"`);
      if ('fromService' in e && !spec.services.some((x) => x.name === e.fromService.name)) throw badRequest(`service "${s.name}" references unknown service "${e.fromService.name}"`);
      if ('fromGroup' in e && !spec.envVarGroups.some((g) => g.name === e.fromGroup)) throw badRequest(`service "${s.name}" references unknown env group "${e.fromGroup}"`);
    }
  }
  return spec;
}

export interface Plan { create: string[]; update: string[]; unchanged: string[] }

export async function planBlueprint(spec: BlueprintSpec, blueprintId: string | null): Promise<Plan> {
  const existing = blueprintId ? await q('SELECT resource_type, name FROM blueprint_resources WHERE blueprint_id = $1', [blueprintId]) : [];
  const has = (t: string, n: string) => existing.some((e) => e.resource_type === t && e.name === n);
  const plan: Plan = { create: [], update: [], unchanged: [] };
  for (const g of spec.envVarGroups) (has('env_group', g.name) ? plan.update : plan.create).push(`envGroup:${g.name}`);
  for (const d of spec.databases) (has('database', d.name) ? plan.unchanged : plan.create).push(`database:${d.name}`);
  for (const s of spec.services) (has('service', s.name) ? plan.update : plan.create).push(`${s.type}:${s.name}`);
  return plan;
}

/** Reads the blueprint file from its branch (or `bp.branch` overridden, e.g. a pull request's head). */
export async function fetchBlueprintFile(bp: Row): Promise<{ text: string; commit: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nav-bp-'));
  try {
    const url = await authedUrl(bp.repo_url, null);
    const res = await git(['clone', '--depth', '1', '--branch', bp.branch, '--single-branch', url, dir], { timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error(`git clone failed: ${res.stderr.split('\n').filter(Boolean).pop()}`);
    const commit = (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const file = path.resolve(dir, bp.file_path);
    if (!file.startsWith(dir)) throw new Error('invalid blueprint path');
    const text = await readFile(file, 'utf8').catch(() => {
      throw new Error(`${bp.file_path} not found on branch ${bp.branch}`);
    });
    return { text, commit };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForDatabase(dbId: string, timeoutMs = 300_000): Promise<Row> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const db = await one('SELECT * FROM databases WHERE id = $1', [dbId]);
    if (db?.status === 'available') return db;
    if (!db || db.status === 'failed') throw new Error(`database ${dbId} failed to provision`);
    if (Date.now() > until) throw new Error(`timed out waiting for database ${db.name}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export interface TrackedResource { type: 'service' | 'database' | 'env_group'; id: string; name: string }

/** Where a spec is applied: the blueprint itself, or a pull request's preview copy of it. */
interface ApplyTarget {
  workspaceId: string;
  repoUrl: string;
  branch: string;
  tracked: TrackedResource[];
  track(r: TrackedResource): Promise<void>;
  preview?: {
    prNumber: number;
    commitSha: string | null;
    /** Spec service name → the blueprint's own service (the preview copy's parent). */
    parents: Map<string, string>;
  };
}

/** Applies a blueprint. Resources are matched by (blueprint, type, name). */
export async function applyBlueprint(bp: Row, spec: BlueprintSpec, log: (m: string) => void): Promise<void> {
  const rows = await q('SELECT * FROM blueprint_resources WHERE blueprint_id = $1', [bp.id]);
  const created = await applySpec(spec, {
    workspaceId: bp.workspace_id,
    repoUrl: bp.repo_url,
    branch: bp.branch,
    tracked: rows.map((r) => ({ type: r.resource_type, id: r.resource_id, name: r.name })),
    track: async (r) => {
      await q('INSERT INTO blueprint_resources (blueprint_id, resource_type, resource_id, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [bp.id, r.type, r.id, r.name]);
    },
  }, log);
  if (spec.previews) await q('UPDATE blueprints SET previews = $2 WHERE id = $1', [bp.id, JSON.stringify(spec.previews)]);
  await recordEvent({ workspaceId: bp.workspace_id, kind: 'blueprint_synced', data: { blueprintId: bp.id, created } });
  await changed(bp.workspace_id, 'blueprint', bp.id);
}

/**
 * Applies a blueprint's spec as a pull request's preview environment: every env group, database and service is
 * copied with a `-pr-<n>` suffix (databases on the free plan), references resolve to the copies, and every service
 * is deployed at the PR head. Idempotent: a later run (new commits) updates the copies in place.
 */
export async function applyPreviewEnvironment(env: Row, bp: Row, spec: BlueprintSpec, log: (m: string) => void): Promise<void> {
  const base = await q("SELECT name, resource_id FROM blueprint_resources WHERE blueprint_id = $1 AND resource_type = 'service'", [bp.id]);
  await applySpec(spec, {
    workspaceId: bp.workspace_id,
    repoUrl: bp.repo_url,
    branch: env.branch,
    tracked: [...(env.resources as TrackedResource[])],
    track: async (r) => {
      const ok = await q('UPDATE preview_environments SET resources = resources || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING id', [env.id, JSON.stringify([r])]);
      // The PR closed while we were creating it: do not leak what was just made.
      if (!ok.length) {
        await deleteResources([r], null);
        throw new Error('preview environment was deleted while it was being created');
      }
    },
    preview: { prNumber: env.pr_number, commitSha: env.commit_sha, parents: new Map(base.map((b) => [b.name as string, b.resource_id as string])) },
  }, log);
  await changed(bp.workspace_id, 'blueprint', bp.id);
}

/** Deletes tracked resources (services through the normal deletion job, databases deprovisioned, groups dropped). */
export async function deleteResources(resources: { type: string; id: string }[], actorId: string | null): Promise<void> {
  for (const r of resources) {
    if (r.type === 'service') {
      const svc = await one("SELECT * FROM services WHERE id = $1 AND status <> 'deleting'", [r.id]);
      if (svc) await markForDeletion(svc, actorId);
    } else if (r.type === 'database') {
      const db = await one("UPDATE databases SET status = 'deleting' WHERE id = $1 AND status <> 'deleting' RETURNING id", [r.id]);
      if (db) await enqueue('db_delete', { databaseId: r.id }, { concurrencyKey: `db:${r.id}` });
    } else {
      await q('DELETE FROM env_groups WHERE id = $1', [r.id]);
    }
  }
}

/** Applies a spec to a target; returns how many services it created. */
async function applySpec(spec: BlueprintSpec, t: ApplyTarget, log: (m: string) => void): Promise<number> {
  const ws = t.workspaceId;
  const pv = t.preview;
  const nm = (n: string) => (pv ? `${n}-pr-${pv.prNumber}` : n);
  const find = (type: string, name: string) => t.tracked.find((r) => r.type === type && r.name === name)?.id;
  const track = async (type: TrackedResource['type'], name: string, id: string) => {
    const r = { type, id, name };
    await t.track(r);
    t.tracked.push(r);
  };

  // 1. Env groups
  const groupIds = new Map<string, string>();
  for (const g of spec.envVarGroups) {
    let gid = find('env_group', g.name);
    const vars = await literalVars(g.envVars, gid ? await listEnv('group', gid) : []);
    if (!gid) {
      gid = (await one("INSERT INTO env_groups (id, workspace_id, name) VALUES ('evg_' || substr(md5(random()::text), 1, 18), $1, $2) ON CONFLICT (workspace_id, name) DO UPDATE SET updated_at = now() RETURNING id", [ws, nm(g.name)]))!.id as string;
      await track('env_group', g.name, gid);
      log(`created env group ${nm(g.name)}`);
    }
    const id_ = gid;
    await tx((c) => replaceEnv(c, 'group', id_, vars));
    groupIds.set(g.name, gid);
  }

  // 2. Databases
  const dbs = new Map<string, Row>();
  for (const d of spec.databases) {
    let dbId = find('database', d.name);
    if (!dbId) {
      // Preview databases start empty on the free plan: they only ever hold a pull request's test data.
      const row = await createDatabase(ws, null, { name: nm(d.name), plan: pv ? 'free' : d.plan, pgVersion: d.postgresMajorVersion, databaseName: d.databaseName, user: d.user, diskGB: d.diskSizeGB });
      dbId = row.id as string;
      await track('database', d.name, dbId);
      log(`created database ${nm(d.name)}`);
    }
    if (d.ipAllowList) await q('UPDATE databases SET ip_allow_list = $2 WHERE id = $1', [dbId, JSON.stringify(d.ipAllowList.map((x) => ({ cidr: x.source, description: x.description })))]);
    dbs.set(d.name, { id: dbId });
  }
  for (const [name, ref] of dbs) {
    if (spec.services.some((s) => (s.envVars ?? []).some((e) => 'fromDatabase' in e && e.fromDatabase.name === name))) {
      log(`waiting for database ${name} to become available`);
      dbs.set(name, await waitForDatabase(ref.id));
    }
  }

  // 3. Services (two passes so fromService can reference services created in this sync)
  const svcIds = new Map<string, string>();
  for (const s of spec.services) {
    const sid = find('service', s.name);
    if (sid) svcIds.set(s.name, sid);
  }
  const created: Row[] = [];
  for (const s of spec.services) {
    const input: CreateServiceInput = {
      name: nm(s.name),
      type: s.type,
      runtime: s.runtime ?? (s.image ? 'image' : s.type === 'static' ? 'static' : 'auto'),
      repoUrl: s.image ? null : s.repo ?? t.repoUrl,
      // Services built from the blueprint's own repo follow it (a preview builds the PR's head branch).
      branch: s.repo ? s.branch ?? null : pv ? t.branch : s.branch ?? t.branch,
      rootDir: s.rootDir,
      imageUrl: s.image?.url ?? null,
      buildCommand: s.buildCommand ?? null,
      startCommand: s.startCommand ?? null,
      preDeployCommand: s.preDeployCommand ?? null,
      dockerfilePath: s.dockerfilePath,
      dockerContext: s.dockerContext,
      healthCheckPath: s.healthCheckPath ?? null,
      plan: pv ? (s.plan === 'free' ? 'free' : 'starter') : s.plan,
      instanceCount: pv ? 1 : s.numInstances ?? s.autoscaling?.min ?? 1,
      // Preview copies are redeployed by pull request events rather than by pushes.
      autoDeploy: pv ? 'off' : s.autoDeployTrigger === 'checksPass' ? 'checks' : s.autoDeployTrigger === 'off' || s.autoDeploy === false ? 'off' : 'commit',
      cronSchedule: s.schedule ?? null,
      publishPath: s.staticPublishPath ?? null,
      disk: s.disk ?? null,
      previews: s.previews && !pv ? { mode: s.previews.generation ?? 'off', expireAfterDays: s.previews.expireAfterDays ?? 7 } : undefined,
      envGroupIds: (s.envVars ?? []).flatMap((e) => ('fromGroup' in e ? [groupIds.get(e.fromGroup)!] : [])),
    };
    let sid = svcIds.get(s.name);
    if (!sid) {
      const res = await createService({
        workspaceId: ws, actorId: null, input, trigger: pv ? 'preview' : 'blueprint', deploy: false,
        parentServiceId: pv?.parents.get(s.name) ?? null, prNumber: pv?.prNumber ?? null,
      });
      sid = res.service.id as string;
      svcIds.set(s.name, sid);
      await track('service', s.name, sid);
      created.push(res.service);
      log(`created ${s.type} service ${nm(s.name)}`);
    } else {
      await q(
        `UPDATE services SET build_command = $2, start_command = $3, pre_deploy_command = $4, health_check_path = $5, plan = COALESCE($6, plan),
         instance_count = $7, cron_schedule = $8, publish_path = $9, root_dir = COALESCE($10, root_dir), auto_deploy = $11, updated_at = now() WHERE id = $1`,
        [sid, input.buildCommand, input.startCommand, input.preDeployCommand, input.healthCheckPath, input.plan ?? null, input.instanceCount, input.cronSchedule, input.publishPath, input.rootDir ?? null, input.autoDeploy],
      );
      await q('DELETE FROM service_env_groups WHERE service_id = $1', [sid]);
      for (const g of input.envGroupIds ?? []) await q('INSERT INTO service_env_groups VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, g]);
      log(`updated ${s.type} service ${nm(s.name)}`);
    }
    if (s.autoscaling && !pv) {
      await q('UPDATE services SET autoscaling = $2 WHERE id = $1', [sid, JSON.stringify({ enabled: true, min: s.autoscaling.min, max: s.autoscaling.max, targetCpuPercent: s.autoscaling.targetCPUPercent ?? 70, targetMemoryPercent: s.autoscaling.targetMemoryPercent ?? null })]);
    }
    if (s.routes || s.headers) await q('UPDATE services SET static_routes = COALESCE($2, static_routes), static_headers = COALESCE($3, static_headers) WHERE id = $1', [sid, s.routes ? JSON.stringify(s.routes) : null, s.headers ? JSON.stringify(s.headers) : null]);
  }
  // Env vars after all services exist (fromService references).
  for (const s of spec.services) {
    const sid = svcIds.get(s.name)!;
    // A preview inherits generated / unsynced values from its parent until it has its own.
    const parentId = pv?.parents.get(s.name);
    const current = [...(await listEnv('service', sid)), ...(parentId ? await listEnv('service', parentId) : [])];
    const vars: EnvVar[] = pv ? [{ key: 'IS_PULL_REQUEST', value: 'true' }] : [];
    for (const e of s.envVars ?? []) {
      if ('fromGroup' in e) continue;
      if ('fromDatabase' in e) {
        const db = dbs.get(e.fromDatabase.name)!;
        const cr = credentials(db);
        const map = { connectionString: cr.internalUrl, host: cr.host, port: String(cr.port), user: cr.user, password: cr.password, database: cr.database };
        vars.push({ key: e.key, value: map[e.fromDatabase.property] });
      } else if ('fromService' in e) {
        const target = await one('SELECT slug, port, internal_port FROM services WHERE id = $1', [svcIds.get(e.fromService.name)]);
        const host = target!.internal_port ? '127.0.0.1' : target!.slug;
        const port = String(target!.internal_port ?? target!.port ?? 10000);
        vars.push({ key: e.key, value: e.fromService.property === 'host' ? host : e.fromService.property === 'port' ? port : `${host}:${port}` });
      } else vars.push(...(await literalVars([e], current)));
    }
    await tx((c) => patchEnv(c, 'service', sid, vars, []));
  }
  if (pv) {
    // Every copy (new or updated) deploys the PR head; services from other repositories deploy their branch.
    for (const s of spec.services) {
      const svc = await one('SELECT * FROM services WHERE id = $1', [svcIds.get(s.name)]);
      if (svc) await createDeploy(svc, { trigger: 'preview', actorId: null, commitSha: !s.repo && !s.image ? pv.commitSha : null });
    }
  } else {
    for (const svc of created) await createDeploy(svc, { trigger: 'blueprint', actorId: null });
  }
  return created.length;
}

async function literalVars(entries: z.infer<typeof EnvEntry>[], current: EnvVar[]): Promise<EnvVar[]> {
  const out: EnvVar[] = [];
  for (const e of entries) {
    if ('value' in e) out.push({ key: e.key, value: e.value });
    else if ('generateValue' in e) out.push({ key: e.key, value: current.find((c) => c.key === e.key)?.value ?? randomBytes(32).toString('base64url') });
    else if ('sync' in e) out.push({ key: e.key, value: current.find((c) => c.key === e.key)?.value ?? '' });
  }
  return out;
}
