// Key Value: Redis-compatible instances on this node. Docker driver: the Valkey image with an append-only volume.
// Process driver: valkey-server (or redis-server) from PATH, supervised by the agent.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '@nav/shared/config';
import { decrypt } from '@nav/shared/crypto';
import { KEY_VALUE_PLANS } from '@nav/shared';
import { one, q, type Row } from '../db/pool.ts';
import { changed, recordEvent } from '../lib/core.ts';
import type { Ctx } from './handlers.ts';
import { freePort, isWin, killTree, pipeLines, shipLog } from './util.ts';

const execFileP = promisify(execFile);
const IMAGE = 'valkey/valkey:8-alpine';
const kvDir = (id: string) => path.join(config.dataDir, 'keyvalue', id);
const kvLog = (kv: Row, message: string, level = 'info') => shipLog({ databaseId: kv.id, stream: 'system' }, message, level);
const running = new Map<string, ChildProcess>();

async function setStatus(kv: Row, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const keys = Object.keys(extra);
  await q(`UPDATE key_values SET status = $2${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')}, updated_at = now() WHERE id = $1`, [kv.id, status, ...keys.map((k) => extra[k])]);
  await changed(kv.workspace_id, 'key_value', kv.id);
}

/** Server settings shared by both drivers. */
function settings(kv: Row, port: number): string[] {
  const plan = KEY_VALUE_PLANS.find((p) => p.id === kv.plan) ?? KEY_VALUE_PLANS[0];
  return [
    `port ${port}`,
    `requirepass ${decrypt(kv.password_enc)}`,
    `maxmemory ${plan.memoryMB}mb`,
    `maxmemory-policy ${kv.maxmemory_policy}`,
    // Free instances are cache-only; paid plans persist with an append-only file.
    `appendonly ${kv.plan === 'free' ? 'no' : 'yes'}`,
    'protected-mode no',
  ];
}

/**
 * A Redis-compatible server for this node: NAV_KV_SERVER if set, else valkey-server or redis-server from PATH, else
 * Memurai on Windows (PATH or its default install folder).
 */
async function serverBinary(): Promise<{ path: string; memurai: boolean } | null> {
  const candidates = [
    ...(process.env.NAV_KV_SERVER ? [process.env.NAV_KV_SERVER] : []),
    ...['valkey-server', 'redis-server', ...(isWin ? ['memurai'] : [])].map((b) => (isWin ? `${b}.exe` : b)),
    ...(isWin ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Memurai', 'memurai.exe')] : []),
  ];
  for (const bin of candidates) {
    const ok = await execFileP(bin, ['--version'], { timeout: 5000, windowsHide: true }).then(() => true, () => false);
    if (ok) return { path: bin, memurai: /memurai/i.test(path.basename(bin)) };
  }
  return null;
}

async function startProcess(kv: Row, port: number): Promise<number> {
  const server = await serverBinary();
  if (!server) throw new Error('Key Value needs the docker driver, or valkey-server / redis-server (Memurai on Windows) on this node');
  const bin = server.path;
  const dir = kvDir(kv.id);
  await mkdir(dir, { recursive: true });
  const conf = path.join(dir, 'kv.conf');
  // Memurai runs in the foreground already and does not accept the Unix-only daemonize option.
  const lines = [...settings(kv, port), `bind ${config.nodeBindIp}`, `dir ${dir.replace(/\\/g, '/')}`, ...(server.memurai ? [] : ['daemonize no'])];
  await writeFile(conf, lines.join('\n') + '\n', { mode: 0o600 });
  const child = spawn(bin, [conf], { cwd: dir, windowsHide: true, detached: !isWin });
  pipeLines(child.stdout!, (l) => kvLog(kv, l));
  pipeLines(child.stderr!, (l) => kvLog(kv, l, 'error'));
  running.set(kv.id, child);
  child.on('exit', (code) => {
    running.delete(kv.id);
    kvLog(kv, `==> Server exited with code ${code}`, code ? 'error' : 'info');
  });
  return child.pid!;
}

async function docker() {
  const Docker = (await import('dockerode')).default;
  return new Docker();
}

async function startContainer(kv: Row, port: number): Promise<string> {
  const d = await docker();
  kvLog(kv, `==> Pulling ${IMAGE}`);
  await new Promise<void>((resolve, reject) => d.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : d.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())))));
  const network = `nav-${kv.workspace_id}`;
  const nets = await d.listNetworks({ filters: { name: [network] } });
  if (!nets.some((n) => n.Name === network)) await d.createNetwork({ Name: network, Driver: 'bridge', Labels: { 'nav.workspace': kv.workspace_id } });
  await d.getContainer(`nav-kv-${kv.id}`).remove({ force: true }).catch(() => {});
  const plan = KEY_VALUE_PLANS.find((p) => p.id === kv.plan) ?? KEY_VALUE_PLANS[0];
  const external = (kv.ip_allow_list ?? []).length > 0;
  const container = await d.createContainer({
    name: `nav-kv-${kv.id}`,
    Image: IMAGE,
    Cmd: ['valkey-server', ...settings(kv, 6379).flatMap((l) => { const [k, ...v] = l.split(' '); return [`--${k}`, v.join(' ')]; })],
    Labels: { 'nav.keyvalue': kv.id },
    HostConfig: {
      NetworkMode: network,
      // Reachable from outside only when an allow list is set (enforced by the host firewall/edge in production).
      PortBindings: { '6379/tcp': [{ HostIp: external ? '0.0.0.0' : config.nodeBindIp, HostPort: String(port) }] },
      Mounts: kv.plan === 'free' ? [] : [{ Type: 'volume', Source: `nav-kv-${kv.id}`, Target: '/data' }],
      Memory: Math.max(64, plan.memoryMB * 1.5) * 1048576,
      NanoCpus: Math.round(plan.cpu * 1e9),
      RestartPolicy: { Name: 'unless-stopped' },
      CapDrop: ['ALL'],
      CapAdd: ['SETUID', 'SETGID', 'CHOWN'],
      SecurityOpt: ['no-new-privileges:true'],
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [kv.slug] } } },
  });
  await container.start();
  return container.id;
}

async function stopInstance(ctx: Ctx, kv: Row, remove: boolean): Promise<void> {
  if (ctx.driver.name === 'docker') {
    const d = await docker();
    const c = d.getContainer(`nav-kv-${kv.id}`);
    if (remove) {
      await c.remove({ force: true }).catch(() => {});
      await d.getVolume(`nav-kv-${kv.id}`).remove().catch(() => {});
    } else await c.stop().catch(() => {});
    return;
  }
  const child = running.get(kv.id);
  if (child) killTree(child.pid, false);
  else if (kv.ref) killTree(Number(kv.ref), true);
  running.delete(kv.id);
  if (remove) await rm(kvDir(kv.id), { recursive: true, force: true }).catch(() => {});
}

async function start(ctx: Ctx, kv: Row): Promise<void> {
  const port = kv.port ?? (await freePort());
  const ref = ctx.driver.name === 'docker' ? await startContainer(kv, port) : String(await startProcess(kv, port));
  await setStatus(kv, 'available', { driver: ctx.driver.name, node_id: ctx.nodeId, ref, host: config.nodeAddress, port });
}

export async function handleKvProvision(ctx: Ctx, payload: { keyValueId: string }): Promise<void> {
  const kv = await one('SELECT * FROM key_values WHERE id = $1', [payload.keyValueId]);
  if (!kv || kv.status === 'deleting') return;
  try {
    kvLog(kv, '==> Creating Key Value instance');
    await start(ctx, kv);
    kvLog(kv, '==> Key Value instance is available');
    await recordEvent({ workspaceId: kv.workspace_id, kind: 'key_value_available', data: { keyValueId: kv.id, name: kv.name } });
  } catch (err) {
    kvLog(kv, `==> Provisioning failed: ${(err as Error).message}`, 'error');
    await setStatus(kv, 'failed');
    await recordEvent({ workspaceId: kv.workspace_id, kind: 'key_value_failed', data: { keyValueId: kv.id, name: kv.name, error: (err as Error).message } });
  }
}

/** Plan, eviction policy and allow-list changes: restart with the new settings (data persists on paid plans). */
export async function handleKvReconfigure(ctx: Ctx, payload: { keyValueId: string }): Promise<void> {
  const kv = await one('SELECT * FROM key_values WHERE id = $1', [payload.keyValueId]);
  if (!kv || kv.status !== 'available') return;
  kvLog(kv, '==> Applying new settings');
  await stopInstance(ctx, kv, false);
  if (ctx.driver.name === 'docker') await (await docker()).getContainer(`nav-kv-${kv.id}`).remove({ force: true }).catch(() => {});
  await start(ctx, kv).catch(async (err) => { kvLog(kv, `==> Restart failed: ${err.message}`, 'error'); await setStatus(kv, 'failed'); });
}

export async function handleKvSuspend(ctx: Ctx, payload: { keyValueId: string }): Promise<void> {
  const kv = await one('SELECT * FROM key_values WHERE id = $1', [payload.keyValueId]);
  if (!kv) return;
  await stopInstance(ctx, kv, false);
  await setStatus(kv, 'suspended');
}

export async function handleKvResume(ctx: Ctx, payload: { keyValueId: string }): Promise<void> {
  const kv = await one('SELECT * FROM key_values WHERE id = $1', [payload.keyValueId]);
  if (!kv) return;
  if (ctx.driver.name === 'docker') await (await docker()).getContainer(`nav-kv-${kv.id}`).start().catch(() => {});
  else await start(ctx, kv);
  await setStatus(kv, 'available');
}

export async function handleKvDelete(ctx: Ctx, payload: { keyValueId: string }): Promise<void> {
  const kv = await one('SELECT * FROM key_values WHERE id = $1', [payload.keyValueId]);
  if (!kv) return;
  await stopInstance(ctx, kv, true);
  await q('DELETE FROM logs WHERE database_id = $1', [kv.id]);
  await q('DELETE FROM key_values WHERE id = $1', [kv.id]);
  await changed(kv.workspace_id, 'key_value', kv.id);
}

/** After an agent restart: process-driver instances that should be running are started again. */
export async function recoverKeyValues(ctx: Ctx): Promise<void> {
  if (ctx.driver.name !== 'process') return;
  for (const kv of await q("SELECT * FROM key_values WHERE node_id = $1 AND status = 'available'", [ctx.nodeId])) {
    if (kv.ref) killTree(Number(kv.ref), true);
    await start(ctx, kv).catch(async (err) => { kvLog(kv, `==> Failed to start: ${err.message}`, 'error'); await setStatus(kv, 'failed'); });
  }
}
