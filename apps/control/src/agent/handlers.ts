// Job handlers executed by the node agent.
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config, publicUrlFor } from '@nav/shared/config';
import { SERVICE_PLANS } from '@nav/shared';
import { notify, one, q, type Row } from '../db/pool.ts';
import { changed, recordEvent } from '../lib/core.ts';
import { authedUrl, git } from '../lib/git.ts';
import { setCommitStatus } from '../lib/github.ts';
import { applyBlueprint, applyPreviewEnvironment, fetchBlueprintFile, parseBlueprint } from '../lib/blueprints.ts';
import { localize, publish, removeLocal, retire } from './artifacts.ts';
import { activeInstances, describePlacement, place, startInstances, stopInstances, waitInstances } from './cluster.ts';
import { detect } from './detect.ts';
import { HEALTH_TIMEOUT_MS, type Entry, type InstanceManager } from './instances.ts';
import type { Artifact, Driver, RegistryAuth } from './runtime/types.ts';
import { decrypt } from '@nav/shared/crypto';
import { flushLogs, shipLog, sleep } from './util.ts';

export interface Ctx { driver: Driver; instances: InstanceManager; nodeId: string }

/** Credentials for pulling from a private registry, decrypted only on the node that pulls. */
export async function registryAuth(credentialId: string | null | undefined): Promise<RegistryAuth | undefined> {
  if (!credentialId) return undefined;
  const c = await one('SELECT registry, username, password_enc FROM registry_credentials WHERE id = $1', [credentialId]);
  return c ? { serveraddress: c.registry, username: c.username, password: decrypt(c.password_enc) } : undefined;
}

const ACTIVE = ['queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress'];
const KEEP_ARTIFACTS = 5;

class DeployError extends Error {
  status: string;
  constructor(status: string, message: string) {
    super(message);
    this.status = status;
  }
}

async function setDeploy(deployId: string, fields: Record<string, unknown>, workspaceId: string, serviceId: string): Promise<void> {
  const keys = Object.keys(fields);
  await q(`UPDATE deploys SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [deployId, ...keys.map((k) => fields[k])]);
  await changed(workspaceId, 'deploy', deployId, serviceId);
}

/** Fetches exactly the requested commit into a fresh directory. */
async function checkout(svc: Row, deploy: Row, dir: string, log: (l: string) => void): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const url = await authedUrl(svc.repo_url, svc.installation_id ? Number(svc.installation_id) : null);
  log(`==> Cloning from ${svc.repo_url}`);
  const run = async (args: string[]) => {
    const r = await git(args, { cwd: dir, timeoutMs: 10 * 60_000, onLine: (l) => log(l.replace(/x-access-token:[^@]+@/g, '')) });
    if (r.code !== 0) throw new DeployError('build_failed', `git ${args[0]} failed: ${r.stderr.trim().split('\n').pop()?.replace(/x-access-token:[^@]+@/g, '')}`);
  };
  await run(['init', '-q']);
  await run(['remote', 'add', 'origin', url]);
  const ref = deploy.commit_sha ?? svc.branch;
  log(`==> Checking out commit ${deploy.commit_sha ?? '(latest)'} in branch ${svc.branch}`);
  const bySha = deploy.commit_sha ? await git(['fetch', '--depth', '1', 'origin', deploy.commit_sha], { cwd: dir, timeoutMs: 10 * 60_000 }) : { code: 1 };
  if (bySha.code !== 0) await run(['fetch', '--depth', '100', 'origin', `+refs/heads/${svc.branch}:refs/remotes/origin/${svc.branch}`]);
  await run(['-c', 'advice.detachedHead=false', 'checkout', '-q', bySha.code === 0 ? 'FETCH_HEAD' : deploy.commit_sha ?? `origin/${svc.branch}`]);
  await run(['submodule', 'update', '--init', '--recursive', '--depth', '1']).catch(() => {});
  void ref;
  return (await git(['log', '-1', '--format=%H%x00%s%x00%an'], { cwd: dir })).stdout.trim();
}

async function cleanupArtifacts(serviceId: string): Promise<void> {
  const old = await q(
    `SELECT id, artifact FROM deploys WHERE service_id = $1 AND artifact IS NOT NULL AND status IN ('deactivated','build_failed','update_failed','pre_deploy_failed','canceled')
     ORDER BY created_at DESC OFFSET $2`,
    [serviceId, KEEP_ARTIFACTS],
  );
  const gone: Artifact[] = [];
  for (const d of old) {
    const shared = await one('SELECT 1 FROM deploys WHERE artifact = $1 AND id <> $2 AND status = \'live\'', [d.artifact, d.id]);
    if (shared) continue;
    gone.push(d.artifact);
    await q('UPDATE deploys SET artifact = NULL WHERE id = $1', [d.id]);
  }
  // Pruned builds are deleted from the store and from every node.
  await retire(gone);
}

// ---------------------------------------------------------------------------------------------------
export async function handleDeploy(ctx: Ctx, payload: { deployId: string; serviceId: string }): Promise<void> {
  let deploy = await one('SELECT * FROM deploys WHERE id = $1', [payload.deployId]);
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!deploy || !svc || deploy.status !== 'queued' || svc.status === 'deleting') return;
  const ws = svc.workspace_id;
  const target = { serviceId: svc.id, deployId: deploy.id, stream: 'build' };
  const log = (l: string, level = 'info') => shipLog(target, l, level);
  const deployLog = (l: string, level = 'info') => shipLog({ ...target, stream: 'deploy' }, l, level);

  // Cancellation: poll the row; abort running commands when the user cancels.
  const abort = new AbortController();
  const poll = setInterval(async () => {
    const r = await one('SELECT status FROM deploys WHERE id = $1', [deploy!.id]).catch(() => null);
    if (r?.status === 'canceled') abort.abort();
  }, 2000);
  const canceled = () => abort.signal.aborted;

  const statusUrl = `${config.dashboardUrl}/w/${ws}/services/${svc.id}/deploys/${deploy.id}`;
  const ghStatus = (state: 'pending' | 'success' | 'failure', desc: string) =>
    deploy!.commit_sha && svc.repo_url ? setCommitStatus(svc.installation_id ? Number(svc.installation_id) : null, svc.repo_url, deploy!.commit_sha, state, desc, statusUrl).catch(() => {}) : undefined;

  const newIds: string[] = [];
  try {
    await setDeploy(deploy.id, { status: 'build_in_progress', started_at: new Date() }, ws, svc.id);
    await ghStatus('pending', 'Deploying on NAV');
    const userEnv = await ctx.instances.runtimeEnv(svc, deploy, null);
    let artifact: Artifact | null = deploy.artifact;

    // ---- Build ----------------------------------------------------------------------------------
    if (artifact) {
      log(`==> Rolling back to the build from deploy ${deploy.rollback_of} (no rebuild needed)`);
    } else if (svc.runtime === 'image') {
      const imageUrl = deploy.config?.imageUrl ?? svc.image_url;
      if (!ctx.driver.pullImage) throw new DeployError('build_failed', 'image-backed services require the docker driver (NAV_DRIVER=docker)');
      artifact = { ...(await ctx.driver.pullImage(imageUrl, log, await registryAuth(svc.registry_credential_id))), registryCredentialId: svc.registry_credential_id ?? undefined };
    } else {
      const buildDir = path.join(config.dataDir, 'builds', deploy.id);
      const [sha, subject, author] = (await checkout(svc, deploy, buildDir, log)).split('\0');
      if (!deploy.commit_sha || !deploy.commit_message) {
        await q('UPDATE deploys SET commit_sha = $2, commit_message = COALESCE(commit_message, $3), commit_author = COALESCE(commit_author, $4) WHERE id = $1', [deploy.id, sha, subject, author]);
        deploy = { ...deploy, commit_sha: sha, commit_message: deploy.commit_message ?? subject };
      }
      if (canceled()) throw new DeployError('canceled', 'canceled');
      const appDir = path.resolve(buildDir, svc.root_dir || '.');
      if (!appDir.startsWith(path.resolve(buildDir)) || !existsSync(appDir)) throw new DeployError('build_failed', `root directory "${svc.root_dir}" not found in repository`);
      const detected = await detect(appDir, svc.runtime, svc.type).catch((err) => { throw new DeployError('build_failed', err.message); });
      for (const n of detected.notes) log(`==> ${n}`);
      if (detected.runtime !== 'docker') log(`==> Using ${detected.runtime} runtime`);
      const buildCommand = svc.build_command ?? detected.buildCommand;
      const startCommand = svc.start_command ?? detected.startCommand;
      try {
        artifact = await ctx.driver.build(
          { deployId: deploy.id, serviceId: svc.id, workspaceId: ws, srcDir: buildDir, appDir, service: svc, env: userEnv.env, files: userEnv.files, clearCache: deploy.clear_cache, log, signal: abort.signal },
          { runtime: detected.runtime, buildCommand, startCommand },
        );
      } catch (err) {
        await rm(buildDir, { recursive: true, force: true }).catch(() => {});
        if (canceled()) throw new DeployError('canceled', 'canceled');
        throw new DeployError('build_failed', (err as Error).message);
      }
      await q('UPDATE deploys SET config = config || $2 WHERE id = $1', [deploy.id, { runtime: detected.runtime, buildCommand, startCommand }]);
    }
    if (!deploy.artifact) {
      try {
        artifact = await publish(ctx, artifact!, deploy.id, log);
      } catch (err) {
        throw new DeployError('build_failed', `could not upload the build: ${(err as Error).message}`);
      }
    }
    await setDeploy(deploy.id, { artifact: JSON.stringify(artifact), build_finished_at: new Date() }, ws, svc.id);
    if (canceled()) throw new DeployError('canceled', 'canceled');

    // ---- Pre-deploy ---------------------------------------------------------------------------------
    if (svc.pre_deploy_command && ['web', 'private', 'worker'].includes(svc.type)) {
      await setDeploy(deploy.id, { status: 'pre_deploy_in_progress' }, ws, svc.id);
      deployLog(`==> Running pre-deploy command '${svc.pre_deploy_command}'`);
      const code = await runOneOff(ctx, svc, deploy, artifact!, svc.pre_deploy_command, (l, lvl) => deployLog(l, lvl), abort.signal, 30 * 60_000);
      if (canceled()) throw new DeployError('canceled', 'canceled');
      if (code !== 0) throw new DeployError('pre_deploy_failed', `pre-deploy command exited with code ${code}`);
      deployLog('==> Pre-deploy command succeeded');
    }

    // ---- Update -------------------------------------------------------------------------------------
    await setDeploy(deploy.id, { status: 'update_in_progress' }, ws, svc.id);
    // Deploying wakes a sleeping free instance (it gets a fresh idle period from the deploy going live).
    const fresh = (await one('UPDATE services SET sleeping = false WHERE id = $1 RETURNING *', [svc.id]))!;
    const old = await activeInstances(svc.id);
    if (['web', 'private', 'worker'].includes(svc.type) && !fresh.suspended) {
      const count = Math.max(1, fresh.instance_count);
      const nodes = await place(fresh, artifact!, count).catch((err) => { throw new DeployError('update_failed', err.message); });
      // A persistent disk can only be attached to one instance: stop the old one first (brief downtime).
      if (fresh.disk && old.length) {
        deployLog('==> Service has a disk: stopping the previous instance before starting the new one');
        await stopInstances(old.map((r) => r.id), 30_000, true);
      }
      deployLog(`==> Starting ${count} instance${count > 1 ? 's' : ''}${await describePlacement(nodes)}`);
      newIds.push(...(await startInstances(fresh, deploy, nodes, deploy.id)));
      const result = await waitInstances(newIds, HEALTH_TIMEOUT_MS + 10 * 60_000, abort.signal);
      if (canceled() || result === 'canceled') throw new DeployError('canceled', 'canceled');
      if (result !== 'healthy') {
        const lost = await one("SELECT 1 FROM instances WHERE id = ANY($1) AND status = 'lost'", [newIds]);
        const what = lost ? 'the node running it went offline' : svc.type === 'web' ? (svc.health_check_path ? `health check ${svc.health_check_path} did not return a successful response` : 'no open port detected — make sure your app listens on the PORT environment variable (0.0.0.0)') : svc.type === 'private' ? 'no open port detected on PORT' : 'process exited';
        throw new DeployError('update_failed', `instance failed to become healthy: ${what}`);
      }
      // Let the edge pick up the new upstreams (LISTEN nav_routes, ~100ms debounce) before reporting live.
      await sleep(750);
      deployLog(`==> Your service is live 🎉${['web'].includes(svc.type) ? `  ${publicUrlFor(svc.slug)}` : ''}`);
    } else {
      deployLog('==> Deploy complete');
    }

    // ---- Promote ------------------------------------------------------------------------------------
    await q("UPDATE deploys SET status = 'deactivated' WHERE service_id = $1 AND status = 'live' AND id <> $2", [svc.id, deploy.id]);
    await setDeploy(deploy.id, { status: 'live', finished_at: new Date() }, ws, svc.id);
    await q("UPDATE services SET current_deploy_id = $2, status = CASE WHEN suspended THEN 'suspended' ELSE 'live' END, updated_at = now() WHERE id = $1", [svc.id, deploy.id]);
    await notify('nav_routes');
    await recordEvent({ workspaceId: ws, serviceId: svc.id, kind: 'deploy_live', data: { deployId: deploy.id, commitSha: deploy.commit_sha, trigger: deploy.trigger } });
    await ghStatus('success', 'Deployed on NAV');
    // Drain the previous deploy's instances (zero-downtime: new ones already serve traffic).
    if (!fresh.disk) await stopInstances(old.map((r) => r.id));
    await cleanupArtifacts(svc.id);
  } catch (err) {
    const e = err instanceof DeployError ? err : new DeployError('update_failed', (err as Error).message);
    await stopInstances(newIds, 2000).catch(() => {});
    if (e.status === 'canceled') {
      await setDeploy(deploy.id, { status: 'canceled', finished_at: new Date() }, ws, svc.id);
      deployLog('==> Deploy canceled', 'warn');
    } else {
      await setDeploy(deploy.id, { status: e.status, error: e.message.slice(0, 2000), finished_at: new Date() }, ws, svc.id);
      shipLog({ ...target, stream: e.status === 'build_failed' ? 'build' : 'deploy' }, `==> ${e.status === 'build_failed' ? 'Build' : 'Deploy'} failed: ${e.message}`, 'error');
      await recordEvent({ workspaceId: ws, serviceId: svc.id, kind: 'deploy_failed', data: { deployId: deploy.id, status: e.status, error: e.message.slice(0, 300) } });
      await ghStatus('failure', e.message);
    }
    await q("UPDATE services SET status = CASE WHEN suspended THEN 'suspended' WHEN current_deploy_id IS NULL THEN 'failed' ELSE 'live' END WHERE id = $1", [svc.id]);
    await changed(ws, 'service', svc.id, svc.id);
  } finally {
    clearInterval(poll);
    await flushLogs();
  }
}

/** Runs a command to completion in the service's artifact (pre-deploy, cron, one-off jobs). */
export async function runOneOff(ctx: Ctx, svc: Row, deploy: Row, artifact: Artifact, command: string | null, log: (l: string, level?: string) => void, signal: AbortSignal, timeoutMs: number): Promise<number> {
  const { env, files } = await ctx.instances.runtimeEnv(svc, deploy, null);
  const plan = SERVICE_PLANS.find((p) => p.id === svc.plan) ?? SERVICE_PLANS[1];
  artifact = await localize(ctx, artifact, (l) => log(l));
  const handle = await ctx.driver.start({
    instanceId: `job-${Date.now().toString(36)}`, serviceId: svc.id, workspaceId: svc.workspace_id, slug: svc.slug, artifact,
    command, env, files, containerPort: null, plan, disk: svc.disk, oneOff: true, onLog: (l, lvl) => log(l, lvl),
  });
  const stop = () => handle.stop(5000);
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { log(`==> Timed out after ${Math.round(timeoutMs / 60000)} minutes`, 'error'); void stop(); }, timeoutMs);
  const code = await handle.exited;
  clearTimeout(timer);
  signal.removeEventListener('abort', stop);
  return code;
}

// ---------------------------------------------------------------------------------------------------
export async function handleScale(_ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!svc || !['web', 'private', 'worker'].includes(svc.type)) return;
  const current = await activeInstances(svc.id);
  // A sleeping free instance runs nothing until the edge wakes it (lib/sleep.ts).
  if (svc.suspended || svc.sleeping || svc.status === 'deleting' || !svc.current_deploy_id) {
    await stopInstances(current.map((r) => r.id), 10_000, true);
    return;
  }
  const deploy = await one('SELECT * FROM deploys WHERE id = $1', [svc.current_deploy_id]);
  if (!deploy?.artifact) return;
  // Stray instances from older deploys go away.
  await stopInstances(current.filter((r) => r.deploy_id !== deploy.id).map((r) => r.id));
  const mine = current.filter((r) => r.deploy_id === deploy.id);
  const want = svc.instance_count;
  const log = (l: string) => shipLog({ serviceId: svc.id, stream: 'system' }, l);
  if (mine.length < want) {
    log(`==> Scaling up to ${want} instance${want > 1 ? 's' : ''}`);
    let ids: string[];
    try {
      ids = await startInstances(svc, deploy, await place(svc, deploy.artifact, want - mine.length));
    } catch (err) {
      log(`==> ${(err as Error).message}`);
      return;
    }
    if ((await waitInstances(ids, 10 * 60_000)) !== 'healthy') log('==> Some new instances failed to become healthy');
  } else if (mine.length > want) {
    log(`==> Scaling down to ${want} instance${want > 1 ? 's' : ''}`);
    // Unhealthy instances go first, then the newest.
    const rank = (r: Row) => (r.status === 'healthy' ? 1 : 0);
    const victims = [...mine].sort((a, b) => rank(a) - rank(b) || +new Date(b.started_at) - +new Date(a.started_at)).slice(0, mine.length - want);
    await stopInstances(victims.map((r) => r.id));
  }
  await q("UPDATE services SET status = 'live' WHERE id = $1 AND status IN ('deploying','suspended','failed') AND NOT suspended", [svc.id]);
  await changed(svc.workspace_id, 'service', svc.id, svc.id);
}

export async function handleRestart(ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!svc?.current_deploy_id || svc.suspended) return;
  const deploy = await one('SELECT * FROM deploys WHERE id = $1', [svc.current_deploy_id]);
  if (!deploy?.artifact) return;
  const log = (l: string) => shipLog({ serviceId: svc.id, stream: 'system' }, l);
  log('==> Rolling restart');
  for (const old of (await activeInstances(svc.id)).filter((r) => r.deploy_id === deploy.id)) {
    if (svc.disk) await stopInstances([old.id], 30_000, true);
    let ids: string[];
    try {
      ids = await startInstances(svc, deploy, await place(svc, deploy.artifact, 1));
    } catch (err) {
      log(`==> ${(err as Error).message}`);
      break;
    }
    if ((await waitInstances(ids, 10 * 60_000)) === 'healthy') {
      if (!svc.disk) await stopInstances([old.id]);
    } else {
      log('==> Replacement instance failed health checks; keeping the existing instance');
      await stopInstances(ids, 2000);
    }
  }
  await handleScale(ctx, payload);
}

export async function handleStop(_ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  await stopInstances((await activeInstances(payload.serviceId)).map((r) => r.id), 10_000, true);
  await notify('nav_routes');
}

export async function handleDeleteService(ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!svc) return;
  await handleStop(ctx, payload);
  ctx.instances.closeLb(svc.id);
  // Builds and disk data are removed on every node (and from the store) by node-targeted cleanup jobs.
  const deploys = await q('SELECT DISTINCT artifact FROM deploys WHERE service_id = $1 AND artifact IS NOT NULL', [svc.id]);
  await retire(deploys.map((d) => d.artifact), svc.id);
  await q("DELETE FROM env_vars WHERE owner_type = 'service' AND owner_id = $1", [svc.id]);
  await q("DELETE FROM secret_files WHERE owner_type = 'service' AND owner_id = $1", [svc.id]);
  await q('DELETE FROM metrics WHERE service_id = $1', [svc.id]);
  await q('DELETE FROM http_metrics WHERE service_id = $1', [svc.id]);
  await q('DELETE FROM logs WHERE service_id = $1', [svc.id]);
  await q('DELETE FROM blueprint_resources WHERE resource_id = $1', [svc.id]);
  await q('DELETE FROM services WHERE id = $1', [svc.id]);
  await notify('nav_routes');
  await changed(svc.workspace_id, 'service', svc.id, svc.id);
}

// --- Node-targeted jobs: run only by the agent of the node they name ---------------------------------

/** Starts an instance the cluster placed on this node and reports whether it became healthy. */
export async function handleInstanceStart(ctx: Ctx, payload: { instanceId: string; deployId: string | null }): Promise<void> {
  const row = await one("UPDATE instances SET status = 'starting', started_at = now() WHERE id = $1 AND node_id = $2 AND status = 'pending' RETURNING *", [payload.instanceId, ctx.nodeId]);
  if (!row) return;
  const log = (l: string, level = 'info') => shipLog(payload.deployId ? { serviceId: row.service_id, deployId: payload.deployId, stream: 'deploy' } : { serviceId: row.service_id, stream: 'system' }, l, level);
  const svc = await one('SELECT * FROM services WHERE id = $1', [row.service_id]);
  const deploy = await one('SELECT * FROM deploys WHERE id = $1', [row.deploy_id]);
  let entry: Entry;
  try {
    if (!svc || !deploy?.artifact || svc.status === 'deleting') throw new Error('the service or its build no longer exists');
    const artifact = await localize(ctx, deploy.artifact, log);
    await ctx.instances.ensureLb(svc);
    entry = await ctx.instances.startAssigned(row.id, svc, deploy, artifact);
  } catch (err) {
    log(`==> Instance ${row.id} could not start: ${(err as Error).message}`, 'error');
    await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE id = $1", [row.id]);
    if (svc) await changed(svc.workspace_id, 'instance', row.id, svc.id);
    return;
  }
  const ok = await ctx.instances.waitHealthy(entry, svc, HEALTH_TIMEOUT_MS, log);
  if (entry.stopping) return;
  // It may have been cancelled (deploy canceled, scaled down) while it was starting.
  const still = (await one('SELECT status FROM instances WHERE id = $1', [row.id]))?.status === 'starting';
  if (ok && still) return ctx.instances.markHealthy(entry);
  if (!ok) log(`==> Instance ${row.id} failed to become healthy`, 'error');
  await ctx.instances.stop(entry, 2000);
}

export async function handleInstanceStop(ctx: Ctx, payload: { instanceId: string; graceMs?: number | null }): Promise<void> {
  const entry = ctx.instances.entries.get(payload.instanceId);
  // Default: the service's graceful shutdown delay (SIGTERM, then SIGKILL after it).
  const delay = payload.graceMs ?? ((await one('SELECT shutdown_delay_s FROM services WHERE id = $1', [entry?.serviceId]))?.shutdown_delay_s ?? 30) * 1000;
  if (entry) return ctx.instances.stop(entry, delay);
  await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE id = $1 AND node_id = $2 AND status NOT IN ('stopped','lost')", [payload.instanceId, ctx.nodeId]);
  await notify('nav_routes');
}

/** Removes this node's copies of retired builds and, for a deleted service, its disk data. */
export async function handleNodeCleanup(ctx: Ctx, payload: { artifacts?: Artifact[]; serviceId?: string | null }): Promise<void> {
  for (const a of payload.artifacts ?? []) if (a) await removeLocal(ctx, a);
  if (payload.serviceId) await ctx.driver.removeServiceData?.(payload.serviceId);
}

// ---------------------------------------------------------------------------------------------------
export async function handleRun(ctx: Ctx, payload: { runId: string; serviceId: string }): Promise<void> {
  const run = await one('SELECT * FROM runs WHERE id = $1', [payload.runId]);
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!run || !svc || run.status !== 'pending') return;
  const deploy = await one('SELECT * FROM deploys WHERE id = $1', [run.deploy_id ?? svc.current_deploy_id]);
  const stream = run.kind === 'cron' ? 'cron' : 'job';
  const log = (l: string, level = 'info') => shipLog({ serviceId: svc.id, runId: run.id, stream }, l, level);
  if (!deploy?.artifact) {
    await q("UPDATE runs SET status = 'failed', finished_at = now() WHERE id = $1", [run.id]);
    return;
  }
  await q("UPDATE runs SET status = 'running', started_at = now() WHERE id = $1", [run.id]);
  await changed(svc.workspace_id, 'run', run.id, svc.id);
  const abort = new AbortController();
  const poll = setInterval(async () => {
    const r = await one('SELECT status FROM runs WHERE id = $1', [run.id]).catch(() => null);
    if (r?.status === 'canceled') abort.abort();
  }, 2000);
  const started = Date.now();
  log(`==> ${run.kind === 'cron' ? 'Cron job' : 'Job'} started: ${run.command}`);
  let code = 1;
  try {
    const cmd = run.command === '(image default command)' ? null : run.command;
    code = await runOneOff(ctx, svc, deploy, deploy.artifact, cmd, log, abort.signal, 12 * 3600_000);
  } catch (err) {
    log(`==> Failed to start: ${(err as Error).message}`, 'error');
  } finally {
    clearInterval(poll);
  }
  const status = abort.signal.aborted ? 'canceled' : code === 0 ? 'succeeded' : 'failed';
  log(`==> ${status === 'succeeded' ? 'Completed' : status === 'canceled' ? 'Canceled' : `Exited with code ${code}`} after ${((Date.now() - started) / 1000).toFixed(1)}s`, status === 'failed' ? 'error' : 'info');
  await q('UPDATE runs SET status = $2, exit_code = $3, finished_at = now() WHERE id = $1', [run.id, status, code]);
  if (status === 'failed' && run.kind === 'cron') await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, kind: 'cron_failed', data: { runId: run.id, exitCode: code } });
  await changed(svc.workspace_id, 'run', run.id, svc.id);
  await flushLogs();
}

// ---------------------------------------------------------------------------------------------------
export async function handleBlueprintSync(_ctx: Ctx, payload: { blueprintId: string }): Promise<void> {
  const bp = await one('SELECT * FROM blueprints WHERE id = $1', [payload.blueprintId]);
  if (!bp) return;
  await q("UPDATE blueprints SET status = 'syncing' WHERE id = $1", [bp.id]);
  await changed(bp.workspace_id, 'blueprint', bp.id);
  try {
    const { text, commit } = await fetchBlueprintFile(bp);
    const spec = parseBlueprint(text);
    await applyBlueprint(bp, spec, (m) => console.log(`[blueprint ${bp.name}] ${m}`));
    await q("UPDATE blueprints SET status = 'in_sync', last_error = NULL, last_synced_at = now(), last_commit = $2 WHERE id = $1", [bp.id, commit]);
  } catch (err) {
    await q("UPDATE blueprints SET status = 'error', last_error = $2 WHERE id = $1", [bp.id, (err as Error).message.slice(0, 2000)]);
  }
  await changed(bp.workspace_id, 'blueprint', bp.id);
}

export { sleep };

/** Builds (or refreshes at the PR head) a blueprint preview environment from the PR branch's blueprint file. */
export async function handleBlueprintPreview(_ctx: Ctx, payload: { previewId: string }): Promise<void> {
  const env = await one('SELECT * FROM preview_environments WHERE id = $1', [payload.previewId]);
  if (!env) return;
  const bp = await one('SELECT * FROM blueprints WHERE id = $1', [env.blueprint_id]);
  if (!bp) return;
  try {
    const { text, commit } = await fetchBlueprintFile({ ...bp, branch: env.branch });
    const spec = parseBlueprint(text);
    await applyPreviewEnvironment({ ...env, commit_sha: env.commit_sha ?? commit }, bp, spec, (m) => console.log(`[preview ${bp.name}#${env.pr_number}] ${m}`));
    await q("UPDATE preview_environments SET status = 'ready', error = NULL, commit_sha = COALESCE(commit_sha, $2), updated_at = now() WHERE id = $1", [env.id, commit]);
  } catch (err) {
    await q("UPDATE preview_environments SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [env.id, (err as Error).message.slice(0, 2000)]);
  }
  await changed(bp.workspace_id, 'blueprint', bp.id);
}
