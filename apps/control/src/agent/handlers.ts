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
import { issueCertificate, verifyDomain } from '../lib/domains.ts';
import { applyBlueprint, fetchBlueprintFile, parseBlueprint } from '../lib/blueprints.ts';
import { detect } from './detect.ts';
import { HEALTH_TIMEOUT_MS, type Entry, type InstanceManager } from './instances.ts';
import type { Artifact, Driver } from './runtime/types.ts';
import { flushLogs, shipLog, sleep } from './util.ts';

export interface Ctx { driver: Driver; instances: InstanceManager; nodeId: string }

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

async function cleanupArtifacts(ctx: Ctx, serviceId: string): Promise<void> {
  const old = await q(
    `SELECT id, artifact FROM deploys WHERE service_id = $1 AND artifact IS NOT NULL AND status IN ('deactivated','build_failed','update_failed','pre_deploy_failed','canceled')
     ORDER BY created_at DESC OFFSET $2`,
    [serviceId, KEEP_ARTIFACTS],
  );
  for (const d of old) {
    const shared = await one('SELECT 1 FROM deploys WHERE artifact = $1 AND id <> $2 AND status = \'live\'', [d.artifact, d.id]);
    if (shared) continue;
    await ctx.driver.removeArtifact(d.artifact);
    await q('UPDATE deploys SET artifact = NULL WHERE id = $1', [d.id]);
  }
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

  const newEntries: Entry[] = [];
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
      artifact = await ctx.driver.pullImage(imageUrl, log);
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
          { deployId: deploy.id, serviceId: svc.id, workspaceId: ws, srcDir: buildDir, appDir, service: svc, env: userEnv.env, clearCache: deploy.clear_cache, log, signal: abort.signal },
          { runtime: detected.runtime, buildCommand, startCommand },
        );
      } catch (err) {
        await rm(buildDir, { recursive: true, force: true }).catch(() => {});
        if (canceled()) throw new DeployError('canceled', 'canceled');
        throw new DeployError('build_failed', (err as Error).message);
      }
      await q('UPDATE deploys SET config = config || $2 WHERE id = $1', [deploy.id, { runtime: detected.runtime, buildCommand, startCommand }]);
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
    const fresh = (await one('SELECT * FROM services WHERE id = $1', [svc.id]))!;
    const old = ctx.instances.forService(svc.id);
    if (['web', 'private', 'worker'].includes(svc.type) && !fresh.suspended) {
      await ctx.instances.ensureLb(fresh);
      const count = Math.max(1, fresh.instance_count);
      // A persistent disk can only be attached to one instance: stop the old one first (brief downtime).
      if (fresh.disk) {
        deployLog('==> Service has a disk: stopping the previous instance before starting the new one');
        for (const e of old) await ctx.instances.stop(e);
      }
      deployLog(`==> Starting ${count} instance${count > 1 ? 's' : ''}`);
      for (let i = 0; i < count; i++) newEntries.push(await ctx.instances.start(fresh, deploy, artifact!));
      const results = await Promise.all(newEntries.map((e) => ctx.instances.waitHealthy(e, fresh, HEALTH_TIMEOUT_MS, deployLog)));
      if (canceled()) throw new DeployError('canceled', 'canceled');
      if (results.some((ok) => !ok)) {
        const what = svc.type === 'web' ? (svc.health_check_path ? `health check ${svc.health_check_path} did not return a successful response` : 'no open port detected — make sure your app listens on the PORT environment variable (0.0.0.0)') : svc.type === 'private' ? 'no open port detected on PORT' : 'process exited';
        throw new DeployError('update_failed', `instance failed to become healthy: ${what}`);
      }
      for (const e of newEntries) await ctx.instances.markHealthy(e);
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
    for (const e of old) if (!fresh.disk) void ctx.instances.stop(e);
    await cleanupArtifacts(ctx, svc.id);
  } catch (err) {
    const e = err instanceof DeployError ? err : new DeployError('update_failed', (err as Error).message);
    for (const n of newEntries) await ctx.instances.stop(n, 2000).catch(() => {});
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
export async function handleScale(ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!svc || !['web', 'private', 'worker'].includes(svc.type)) return;
  const current = ctx.instances.forService(svc.id);
  if (svc.suspended || svc.status === 'deleting' || !svc.current_deploy_id) {
    for (const e of current) await ctx.instances.stop(e, 10_000);
    return;
  }
  const deploy = await one('SELECT * FROM deploys WHERE id = $1', [svc.current_deploy_id]);
  if (!deploy?.artifact) return;
  await ctx.instances.ensureLb(svc);
  // Stray instances from older deploys go away.
  for (const e of current.filter((e) => e.deployId !== deploy.id)) await ctx.instances.stop(e);
  const mine = ctx.instances.forService(svc.id);
  const want = svc.instance_count;
  const log = (l: string) => shipLog({ serviceId: svc.id, stream: 'system' }, l);
  if (mine.length < want) {
    log(`==> Scaling up to ${want} instance${want > 1 ? 's' : ''}`);
    const started = [];
    for (let i = mine.length; i < want; i++) started.push(await ctx.instances.start(svc, deploy, deploy.artifact));
    await Promise.all(started.map(async (e) => {
      if (await ctx.instances.waitHealthy(e, svc, 5 * 60_000)) await ctx.instances.markHealthy(e);
      else { log(`==> Instance ${e.instanceId} failed to become healthy`); await ctx.instances.stop(e, 2000); }
    }));
  } else if (mine.length > want) {
    log(`==> Scaling down to ${want} instance${want > 1 ? 's' : ''}`);
    for (const e of mine.slice(want)) await ctx.instances.stop(e);
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
  for (const old of ctx.instances.forService(svc.id)) {
    if (svc.disk) await ctx.instances.stop(old);
    const fresh = await ctx.instances.start(svc, deploy, deploy.artifact);
    if (await ctx.instances.waitHealthy(fresh, svc, 5 * 60_000)) {
      await ctx.instances.markHealthy(fresh);
      if (!svc.disk) await ctx.instances.stop(old);
    } else {
      log('==> Replacement instance failed health checks; keeping the existing instance');
      await ctx.instances.stop(fresh, 2000);
    }
  }
  await handleScale(ctx, payload);
}

export async function handleStop(ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  for (const e of ctx.instances.forService(payload.serviceId)) await ctx.instances.stop(e, 10_000);
  await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE service_id = $1 AND node_id = $2 AND status <> 'stopped'", [payload.serviceId, ctx.nodeId]);
  await notify('nav_routes');
}

export async function handleDeleteService(ctx: Ctx, payload: { serviceId: string }): Promise<void> {
  const svc = await one('SELECT * FROM services WHERE id = $1', [payload.serviceId]);
  if (!svc) return;
  await handleStop(ctx, payload);
  ctx.instances.closeLb(svc.id);
  const deploys = await q('SELECT artifact FROM deploys WHERE service_id = $1 AND artifact IS NOT NULL', [svc.id]);
  for (const d of deploys) await ctx.driver.removeArtifact(d.artifact);
  await ctx.driver.removeServiceData?.(svc.id);
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
export async function handleVerifyDomain(_ctx: Ctx, payload: { domainId: string }): Promise<void> {
  await verifyDomain(payload.domainId);
}

export async function handleIssueCert(_ctx: Ctx, payload: { domainId: string }): Promise<void> {
  await issueCertificate(payload.domainId, (m) => console.log(`[acme] ${m}`));
}

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
