// Instance lifecycle on this node: start, health-check, supervise (restart with backoff), drain, sample usage.
// Instances are placed by the cluster (cluster.ts); this node starts the ones assigned to it.
import net from 'node:net';
import { config, publicUrlFor } from '@nav/shared/config';
import { SERVICE_PLANS } from '@nav/shared';
import { notify, one, q, type Row } from '../db/pool.ts';
import { changed, recordEvent } from '../lib/core.ts';
import { resolveServiceEnv } from '../lib/env.ts';
import { workflowsToken } from '../lib/workflows.ts';
import { DEFAULT_CONTAINER_PORT } from './runtime/docker.ts';
import type { Artifact, Driver, Handle } from './runtime/types.ts';
import { freePort, healthy, shipLog, sleep } from './util.ts';

export interface Entry {
  instanceId: string;
  serviceId: string;
  deployId: string;
  workspaceId: string;
  handle: Handle | null;
  stopping: boolean;
  restarts: number;
}

export const HEALTH_TIMEOUT_MS = Number(process.env.NAV_HEALTH_TIMEOUT_MS ?? 15 * 60_000);
const DRAIN_GRACE_MS = 30_000;

export class InstanceManager {
  readonly entries = new Map<string, Entry>();
  private lbs = new Map<string, { server: net.Server; port: number; rr: number; targets: { host: string; port: number }[] }>();
  private driver: Driver;
  private nodeId: string;

  constructor(driver: Driver, nodeId: string) {
    this.driver = driver;
    this.nodeId = nodeId;
  }

  /** Environment injected into every instance, run and build. */
  async runtimeEnv(svc: Row, deploy: Row, instanceId: string | null): Promise<{ env: Record<string, string>; files: { filename: string; content: string }[] }> {
    const { env, files } = await resolveServiceEnv(svc.id);
    const url = ['web', 'static'].includes(svc.type) ? publicUrlFor(svc.slug) : '';
    const repoSlug = svc.repo_url ? new URL(svc.repo_url).pathname.replace(/^\//, '').replace(/\.git$/, '') : '';
    return {
      env: {
        ...env,
        NAV: 'true',
        NAV_SERVICE_ID: svc.id,
        NAV_SERVICE_NAME: svc.name,
        NAV_SERVICE_TYPE: svc.type,
        NAV_DEPLOY_ID: deploy.id,
        ...(instanceId ? { NAV_INSTANCE_ID: instanceId } : {}),
        NAV_GIT_COMMIT: deploy.commit_sha ?? '',
        NAV_GIT_BRANCH: deploy.branch ?? svc.branch ?? '',
        NAV_GIT_REPO_SLUG: repoSlug,
        NAV_EXTERNAL_URL: url,
        NAV_EXTERNAL_HOSTNAME: url ? `${svc.slug}.${config.appsDomain}` : '',
        NAV_DISCOVERY_SERVICE: svc.slug,
        // Lets any service start and follow workflow runs in its workspace (packages/workflows createClient).
        // Never pull request previews: they run code that has not been merged (possibly from a fork).
        NAV_API_URL: `${config.apiPublicUrl}/api/v1`,
        ...(svc.parent_service_id || svc.pr_number ? {} : { NAV_WORKFLOWS_TOKEN: workflowsToken(svc.workspace_id) }),
        IS_PULL_REQUEST: svc.parent_service_id ? 'true' : (env.IS_PULL_REQUEST ?? 'false'),
      },
      files,
    };
  }

  /** Starts an instance the cluster assigned to this node (its row already exists). */
  async startAssigned(instanceId: string, svc: Row, deploy: Row, artifact: Artifact): Promise<Entry> {
    const entry: Entry = { instanceId, serviceId: svc.id, deployId: deploy.id, workspaceId: svc.workspace_id, handle: null, stopping: false, restarts: 0 };
    this.entries.set(instanceId, entry);
    try {
      await this.launch(entry, svc, deploy, artifact);
    } catch (err) {
      this.entries.delete(instanceId);
      throw err;
    }
    await changed(svc.workspace_id, 'instance', instanceId, svc.id);
    return entry;
  }

  private async launch(entry: Entry, svc: Row, deploy: Row, artifact: Artifact): Promise<void> {
    const plan = SERVICE_PLANS.find((p) => p.id === svc.plan) ?? SERVICE_PLANS[1];
    const { env, files } = await this.runtimeEnv(svc, deploy, entry.instanceId);
    const target = { serviceId: svc.id, instanceId: entry.instanceId, deployId: null, stream: 'runtime' };
    const handle = await this.driver.start({
      instanceId: entry.instanceId,
      serviceId: svc.id,
      workspaceId: svc.workspace_id,
      slug: svc.slug,
      artifact,
      command: svc.start_command && artifact.kind === 'dir' && artifact.runtime !== 'static' ? svc.start_command : artifact.startCommand ?? svc.start_command,
      env,
      files,
      containerPort: svc.type === 'worker' ? null : svc.port ?? DEFAULT_CONTAINER_PORT,
      plan,
      disk: svc.disk,
      oneOff: false,
      onLog: (line, level) => shipLog(target, line, level ?? 'info'),
    });
    entry.handle = handle;
    // A stop that raced the start keeps its status; the starter notices and stops the process.
    await q("UPDATE instances SET ref = $2, host = $3, port = $4, status = CASE WHEN status IN ('stopped','lost','draining') THEN status ELSE 'starting' END WHERE id = $1", [entry.instanceId, handle.ref, handle.host, handle.port]);
    handle.exited.then((code) => this.onExit(entry, code, svc.id));
  }

  private async onExit(entry: Entry, code: number, serviceId: string): Promise<void> {
    if (entry.stopping) return;
    const wasHealthy = (await one('SELECT status FROM instances WHERE id = $1', [entry.instanceId]))?.status === 'healthy';
    await q("UPDATE instances SET status = 'crashed', last_exit_code = $2 WHERE id = $1", [entry.instanceId, code]);
    if (wasHealthy) await notify('nav_routes');
    shipLog({ serviceId, instanceId: entry.instanceId, stream: 'runtime' }, `==> Instance exited with code ${code}`, 'error');
    const svc = await one('SELECT * FROM services WHERE id = $1', [serviceId]);
    if (!svc || svc.suspended || svc.status === 'deleting') return;
    // Only instances of the live deploy are restarted; a failing new deploy is handled by the deploy job.
    if (svc.current_deploy_id !== entry.deployId) return;
    if (entry.restarts === 0 || entry.restarts % 5 === 0) {
      await recordEvent({ workspaceId: svc.workspace_id, serviceId, kind: 'instance_crashed', data: { instanceId: entry.instanceId, exitCode: code, restarts: entry.restarts } });
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(entry.restarts, 6));
    entry.restarts++;
    shipLog({ serviceId, instanceId: entry.instanceId, stream: 'runtime' }, `==> Restarting in ${Math.round(delay / 1000)}s (restart #${entry.restarts})`, 'warn');
    await sleep(delay);
    if (entry.stopping) return;
    const deploy = await one('SELECT * FROM deploys WHERE id = $1', [entry.deployId]);
    if (!deploy?.artifact) return;
    await q('UPDATE instances SET restart_count = $2 WHERE id = $1', [entry.instanceId, entry.restarts]);
    try {
      await this.launch(entry, svc, deploy, deploy.artifact);
      if (await this.waitHealthy(entry, svc, 5 * 60_000)) await this.markHealthy(entry);
    } catch (err) {
      shipLog({ serviceId, instanceId: entry.instanceId, stream: 'runtime' }, `==> Restart failed: ${(err as Error).message}`, 'error');
    }
  }

  /** web: HTTP health path (or TCP); private: TCP; worker: stays up for 5s. */
  async waitHealthy(entry: Entry, svc: Row, timeoutMs = HEALTH_TIMEOUT_MS, log?: (l: string) => void): Promise<boolean> {
    const h = entry.handle!;
    let exited = false;
    h.exited.then(() => (exited = true));
    if (svc.type === 'worker') {
      await sleep(5000);
      return !exited;
    }
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (exited || entry.stopping) return false;
      if (h.port && (await healthy(h.host, h.port, svc.type === 'web' ? svc.health_check_path : null))) return true;
      attempt++;
      if (log && attempt % 15 === 0) log(`==> Waiting for ${svc.type === 'web' && svc.health_check_path ? `health check ${svc.health_check_path}` : `port ${h.port}`} to respond...`);
      await sleep(1000);
    }
    return false;
  }

  async markHealthy(entry: Entry): Promise<void> {
    await q("UPDATE instances SET status = 'healthy' WHERE id = $1", [entry.instanceId]);
    await notify('nav_routes');
    void this.syncLbs().catch(() => {});
    await changed(entry.workspaceId, 'instance', entry.instanceId, entry.serviceId);
  }

  async stop(entry: Entry, graceMs = DRAIN_GRACE_MS): Promise<void> {
    entry.stopping = true;
    await q("UPDATE instances SET status = 'draining' WHERE id = $1 AND status <> 'stopped'", [entry.instanceId]);
    await notify('nav_routes');
    // Give the edge a moment to drop the upstream before signalling the process.
    await sleep(500);
    await entry.handle?.stop(graceMs).catch(() => {});
    await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE id = $1", [entry.instanceId]);
    this.entries.delete(entry.instanceId);
    await changed(entry.workspaceId, 'instance', entry.instanceId, entry.serviceId);
  }

  forService(serviceId: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.serviceId === serviceId && !e.stopping);
  }

  // --- Private networking (process driver): stable 127.0.0.1:<internal_port> TCP load balancer ---------
  // Every node runs a balancer for every service, so a service reaches another one on the same local port
  // wherever its instances were placed. Targets are the cluster's healthy instances.

  /** Opens balancers for new services, refreshes targets, and closes balancers of deleted services. */
  async syncLbs(): Promise<void> {
    if (this.driver.name !== 'process') return;
    const svcs = await q("SELECT id, slug, type, internal_port FROM services WHERE type IN ('web','private') AND internal_port IS NOT NULL AND status <> 'deleting'");
    const ups = await q("SELECT service_id, host, port FROM instances WHERE status = 'healthy' AND port IS NOT NULL");
    for (const s of svcs) await this.ensureLb(s);
    const keep = new Set(svcs.map((s) => s.id));
    for (const [sid, lb] of this.lbs) {
      if (!keep.has(sid)) { this.closeLb(sid); continue; }
      lb.targets = ups.filter((u) => u.service_id === sid).map((u) => ({ host: u.host, port: u.port }));
    }
  }

  async ensureLb(svc: Row): Promise<void> {
    if (this.driver.name !== 'process' || !['web', 'private'].includes(svc.type) || this.lbs.has(svc.id)) return;
    let port: number = svc.internal_port;
    if (!port) {
      const candidate = await freePort();
      const row = await one('UPDATE services SET internal_port = COALESCE(internal_port, $2) WHERE id = $1 RETURNING internal_port', [svc.id, candidate]);
      port = row!.internal_port;
    }
    const lb = { server: net.createServer(), port, rr: 0, targets: [] as { host: string; port: number }[] };
    lb.server.on('connection', (client) => {
      if (!lb.targets.length) return client.destroy();
      const t = lb.targets[lb.rr++ % lb.targets.length];
      const upstream = net.connect({ host: t.host, port: t.port });
      client.pipe(upstream).pipe(client);
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on('error', close);
      upstream.on('error', close);
    });
    await new Promise<void>((resolve) => {
      lb.server.once('error', (err) => { console.error(`[agent] internal LB for ${svc.slug} failed on :${port}: ${err.message}`); resolve(); });
      lb.server.listen(port, '127.0.0.1', () => resolve());
    });
    this.lbs.set(svc.id, lb);
  }


  closeLb(serviceId: string): void {
    this.lbs.get(serviceId)?.server.close();
    this.lbs.delete(serviceId);
  }

  // --- Metrics ------------------------------------------------------------------------------------

  async sample(): Promise<void> {
    const live = [...this.entries.values()].filter((e) => e.handle && !e.stopping);
    if (!live.length) return;
    const usage = await this.driver.usage(live.map((e) => e.handle!.ref));
    const rows: unknown[] = [];
    const values: string[] = [];
    const now = new Date();
    for (const e of live) {
      const u = usage.get(e.handle!.ref);
      if (!u) continue;
      rows.push(e.serviceId, e.instanceId, now, u.cpu, Math.round(u.memBytes));
      const n = rows.length;
      values.push(`($${n - 4},$${n - 3},$${n - 2},$${n - 1},$${n})`);
    }
    if (values.length) await q(`INSERT INTO metrics (service_id, instance_id, ts, cpu, mem_bytes) VALUES ${values.join(',')}`, rows);
  }
}
