// Infrastructure-as-code: parse nav.yaml, compute a plan against current state, and apply it.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { CreateServiceInput, EnvVar } from '@nav/shared';
import { one, q, tx, type Row } from '../db/pool.ts';
import { badRequest, changed, recordEvent } from './core.ts';
import { listEnv, patchEnv, replaceEnv } from './env.ts';
import { authedUrl, git } from './git.ts';
import { createService, validateCron } from './services.ts';
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
  type: z.enum(['web', 'private', 'pserv', 'worker', 'cron', 'static']).transform((t) => (t === 'pserv' ? 'private' : t) as 'web' | 'private' | 'worker' | 'cron' | 'static'),
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

/** Applies a blueprint. Resources are matched by (blueprint, type, name). */
export async function applyBlueprint(bp: Row, spec: BlueprintSpec, log: (m: string) => void): Promise<void> {
  const ws = bp.workspace_id;
  const tracked = await q('SELECT * FROM blueprint_resources WHERE blueprint_id = $1', [bp.id]);
  const find = (type: string, name: string) => tracked.find((t) => t.resource_type === type && t.name === name)?.resource_id as string | undefined;
  const track = (type: string, name: string, resourceId: string) =>
    q('INSERT INTO blueprint_resources (blueprint_id, resource_type, resource_id, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [bp.id, type, resourceId, name]);

  // 1. Env groups
  const groupIds = new Map<string, string>();
  for (const g of spec.envVarGroups) {
    let gid = find('env_group', g.name);
    const vars = await literalVars(g.envVars, gid ? await listEnv('group', gid) : []);
    if (!gid) {
      gid = (await one("INSERT INTO env_groups (id, workspace_id, name) VALUES ('evg_' || substr(md5(random()::text), 1, 18), $1, $2) ON CONFLICT (workspace_id, name) DO UPDATE SET updated_at = now() RETURNING id", [ws, g.name]))!.id as string;
      await track('env_group', g.name, gid);
      log(`created env group ${g.name}`);
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
      const row = await createDatabase(ws, null, { name: d.name, plan: d.plan, pgVersion: d.postgresMajorVersion, databaseName: d.databaseName, user: d.user, diskGB: d.diskSizeGB });
      dbId = row.id as string;
      await track('database', d.name, dbId);
      log(`created database ${d.name}`);
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
      name: s.name,
      type: s.type,
      runtime: s.runtime ?? (s.image ? 'image' : s.type === 'static' ? 'static' : 'auto'),
      repoUrl: s.image ? null : s.repo ?? bp.repo_url,
      branch: s.branch ?? (s.repo ? null : bp.branch),
      rootDir: s.rootDir,
      imageUrl: s.image?.url ?? null,
      buildCommand: s.buildCommand ?? null,
      startCommand: s.startCommand ?? null,
      preDeployCommand: s.preDeployCommand ?? null,
      dockerfilePath: s.dockerfilePath,
      dockerContext: s.dockerContext,
      healthCheckPath: s.healthCheckPath ?? null,
      plan: s.plan,
      instanceCount: s.numInstances ?? s.autoscaling?.min ?? 1,
      autoDeploy: s.autoDeploy === false ? 'off' : 'commit',
      cronSchedule: s.schedule ?? null,
      publishPath: s.staticPublishPath ?? null,
      disk: s.disk ?? null,
      previews: s.previews ? { mode: s.previews.generation ?? 'off', expireAfterDays: s.previews.expireAfterDays ?? 7 } : undefined,
      envGroupIds: (s.envVars ?? []).flatMap((e) => ('fromGroup' in e ? [groupIds.get(e.fromGroup)!] : [])),
    };
    let sid = svcIds.get(s.name);
    if (!sid) {
      const res = await createService({ workspaceId: ws, actorId: null, input, trigger: 'blueprint', deploy: false });
      sid = res.service.id as string;
      svcIds.set(s.name, sid);
      await track('service', s.name, sid);
      created.push(res.service);
      log(`created ${s.type} service ${s.name}`);
    } else {
      await q(
        `UPDATE services SET build_command = $2, start_command = $3, pre_deploy_command = $4, health_check_path = $5, plan = COALESCE($6, plan),
         instance_count = $7, cron_schedule = $8, publish_path = $9, root_dir = COALESCE($10, root_dir), auto_deploy = $11, updated_at = now() WHERE id = $1`,
        [sid, input.buildCommand, input.startCommand, input.preDeployCommand, input.healthCheckPath, input.plan ?? null, input.instanceCount, input.cronSchedule, input.publishPath, input.rootDir ?? null, input.autoDeploy],
      );
      await q('DELETE FROM service_env_groups WHERE service_id = $1', [sid]);
      for (const g of input.envGroupIds ?? []) await q('INSERT INTO service_env_groups VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, g]);
      log(`updated ${s.type} service ${s.name}`);
    }
    if (s.autoscaling) {
      await q('UPDATE services SET autoscaling = $2 WHERE id = $1', [sid, JSON.stringify({ enabled: true, min: s.autoscaling.min, max: s.autoscaling.max, targetCpuPercent: s.autoscaling.targetCPUPercent ?? 70, targetMemoryPercent: s.autoscaling.targetMemoryPercent ?? null })]);
    }
    if (s.routes || s.headers) await q('UPDATE services SET static_routes = COALESCE($2, static_routes), static_headers = COALESCE($3, static_headers) WHERE id = $1', [sid, s.routes ? JSON.stringify(s.routes) : null, s.headers ? JSON.stringify(s.headers) : null]);
  }
  // Env vars after all services exist (fromService references).
  for (const s of spec.services) {
    const sid = svcIds.get(s.name)!;
    const current = await listEnv('service', sid);
    const vars: EnvVar[] = [];
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
  for (const svc of created) await createDeploy(svc, { trigger: 'blueprint', actorId: null });
  await recordEvent({ workspaceId: ws, kind: 'blueprint_synced', data: { blueprintId: bp.id, created: created.length } });
  await changed(ws, 'blueprint', bp.id);
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
