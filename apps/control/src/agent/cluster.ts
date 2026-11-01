// Cluster orchestration: places instances on nodes and drives them through node-targeted jobs. Any agent can run
// these (deploy, scale, restart); the instance itself is started and supervised by the agent of its node.
import { DATABASE_PLANS, SERVICE_PLANS } from '@nav/shared';
import { id } from '@nav/shared/ids';
import { notify, one, q, type Row } from '../db/pool.ts';
import { enqueue } from '../lib/core.ts';
import type { Artifact } from './runtime/types.ts';
import { sleep } from './util.ts';

/** A node that has not heartbeated for this long is considered down. */
export const NODE_TTL_S = 45;
/** Instances that occupy capacity and count towards a service's instance count. */
export const ACTIVE = ['pending', 'starting', 'healthy', 'unhealthy', 'crashed'];
/** Keep this share of each node's memory for the agent, the OS and build containers. */
const RESERVED = 0.15;

export class PlacementError extends Error {}

export async function liveNodes(): Promise<Row[]> {
  return q('SELECT * FROM nodes WHERE last_heartbeat > now() - make_interval(secs => $1) ORDER BY id', [NODE_TTL_S]);
}

export async function activeInstances(serviceId: string): Promise<Row[]> {
  return q('SELECT * FROM instances WHERE service_id = $1 AND status = ANY($2) ORDER BY started_at', [serviceId, ACTIVE]);
}

/** Memory (MB) already promised on each node to instances and databases. */
async function committedMemory(): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  const add = (node: string, mb: number) => used.set(node, (used.get(node) ?? 0) + mb);
  for (const r of await q('SELECT i.node_id, s.plan FROM instances i JOIN services s ON s.id = i.service_id WHERE i.status = ANY($1)', [ACTIVE])) {
    add(r.node_id, (SERVICE_PLANS.find((p) => p.id === r.plan) ?? SERVICE_PLANS[1]).memoryMB);
  }
  for (const r of await q("SELECT node_id, plan FROM databases WHERE node_id IS NOT NULL AND status NOT IN ('suspended','deleting')")) {
    add(r.node_id, (DATABASE_PLANS.find((p) => p.id === r.plan) ?? DATABASE_PLANS[0]).memoryMB);
  }
  return used;
}

/**
 * Chooses a node for each of `count` new instances. Hard constraints: the node is up and not draining, its driver
 * can run the artifact, it can obtain the artifact, and a service with a disk stays on the disk's node. Then it
 * spreads a service's instances across nodes and prefers the node with the most free memory.
 */
export async function place(svc: Row, artifact: Artifact, count: number): Promise<Row[]> {
  const nodes = (await liveNodes()).filter((n) => !n.draining);
  const driver = artifact.kind === 'image' ? 'docker' : 'process';
  let candidates = nodes.filter((n) => n.driver === driver);
  const why: string[] = [];
  if (!candidates.length) why.push(`no ${driver} node is online`);
  const reachable = artifact.store || (artifact.kind === 'image' && !artifact.ref.startsWith('nav/')) || !artifact.nodeId;
  if (!reachable) {
    candidates = candidates.filter((n) => n.id === artifact.nodeId);
    if (!candidates.length && !why.length) why.push(`the build exists only on node ${artifact.nodeId}, which is offline; redeploy to rebuild it`);
  }
  if (svc.disk && svc.node_id) {
    candidates = candidates.filter((n) => n.id === svc.node_id);
    if (!candidates.length && !why.length) why.push(`the service's disk is on node ${svc.node_id}, which is offline`);
  }
  if (!candidates.length) throw new PlacementError(`cannot place instance: ${why.join('; ') || 'no eligible node'}`);

  const plan = SERVICE_PLANS.find((p) => p.id === svc.plan) ?? SERVICE_PLANS[1];
  const used = await committedMemory();
  const mine = new Map<string, number>();
  for (const r of await activeInstances(svc.id)) mine.set(r.node_id, (mine.get(r.node_id) ?? 0) + 1);
  const free = (n: Row) => Number(n.capacity?.memoryMB ?? 0) * (1 - RESERVED) - (used.get(n.id) ?? 0);

  const chosen: Row[] = [];
  for (let i = 0; i < count; i++) {
    const best = [...candidates].sort((a, b) =>
      Number(free(b) >= plan.memoryMB) - Number(free(a) >= plan.memoryMB) // fits before overcommits
      || (mine.get(a.id) ?? 0) - (mine.get(b.id) ?? 0) // spread replicas
      || free(b) - free(a)
      || a.id.localeCompare(b.id))[0];
    chosen.push(best);
    used.set(best.id, (used.get(best.id) ?? 0) + plan.memoryMB);
    mine.set(best.id, (mine.get(best.id) ?? 0) + 1);
  }
  if (svc.disk && !svc.node_id) await q('UPDATE services SET node_id = $2 WHERE id = $1 AND node_id IS NULL', [svc.id, chosen[0].id]);
  return chosen;
}

/** Records the instances as pending on their nodes and asks each node's agent to start its own. */
export async function startInstances(svc: Row, deploy: Row, nodes: Row[], logDeployId: string | null = null): Promise<string[]> {
  const ids: string[] = [];
  for (const node of nodes) {
    const instanceId = id('ins');
    await q("INSERT INTO instances (id, service_id, deploy_id, node_id, driver, host, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')", [instanceId, svc.id, deploy.id, node.id, node.driver, node.address]);
    await enqueue('instance_start', { instanceId, deployId: logDeployId }, { nodeId: node.id, maxAttempts: 3 });
    ids.push(instanceId);
  }
  return ids;
}

/** Waits until every instance is healthy ('healthy'), any of them is gone ('failed'), or the wait is aborted. */
export async function waitInstances(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<'healthy' | 'failed' | 'canceled'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'canceled';
    const rows = await q(
      `SELECT i.status, n.last_heartbeat > now() - make_interval(secs => $2) AS node_up
       FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.id = ANY($1)`,
      [ids, NODE_TTL_S],
    );
    if (rows.some((r) => ['stopped', 'lost', 'draining'].includes(r.status) || !r.node_up)) return 'failed';
    if (rows.length === ids.length && rows.every((r) => r.status === 'healthy')) return 'healthy';
    await sleep(1000);
  }
  return 'failed';
}

/**
 * Stops instances wherever they run. A pending instance that no agent has picked up yet is cancelled in place;
 * the rest are stopped by their node. With `wait`, returns once all of them are down.
 */
export async function stopInstances(ids: string[], graceMs = 30_000, wait = false): Promise<void> {
  if (!ids.length) return;
  await q("UPDATE instances SET status = 'stopped', stopped_at = now() WHERE id = ANY($1) AND status = 'pending'", [ids]);
  const rows = await q("SELECT id, node_id FROM instances WHERE id = ANY($1) AND status NOT IN ('stopped','lost')", [ids]);
  for (const r of rows) await enqueue('instance_stop', { instanceId: r.id, graceMs }, { nodeId: r.node_id, maxAttempts: 3 });
  await notify('nav_routes');
  if (!wait || !rows.length) return;
  const deadline = Date.now() + graceMs + 30_000;
  while (Date.now() < deadline) {
    const left = await one(
      `SELECT count(*)::int AS n FROM instances i LEFT JOIN nodes n ON n.id = i.node_id
       WHERE i.id = ANY($1) AND i.status NOT IN ('stopped','lost') AND n.last_heartbeat > now() - make_interval(secs => $2)`,
      [rows.map((r) => r.id), NODE_TTL_S],
    );
    if (!left?.n) return;
    await sleep(500);
  }
}

/** Short "on node-a, node-b" summary for deploy logs when the cluster has more than one node. */
export async function describePlacement(nodes: Row[]): Promise<string> {
  if ((await liveNodes()).length < 2) return '';
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
  return ` on ${[...counts].map(([h, c]) => (c > 1 ? `${h} (×${c})` : h)).join(', ')}`;
}
