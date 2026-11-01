// Sandboxes on the control plane: placement on a node, the private HTTP calls to that node's agent, teardown and
// TTL expiry. The agent holds the sandbox itself; the database row is the source of truth for status and TTL.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { nodeToken } from '@nav/shared/artifacts';
import { config } from '@nav/shared/config';
import type { Sandbox, SandboxSnapshot } from '@nav/shared';
import { one, q, type Row } from '../db/pool.ts';
import { NODE_TTL_S } from '../agent/cluster.ts';
import { HttpError } from './core.ts';

export const LIVE = ['starting', 'running'];

export function sandboxOut(r: Row): Sandbox {
  return {
    id: r.id, workspaceId: r.workspace_id, name: r.name, runtime: r.runtime, image: r.image, plan: r.plan,
    networkAccess: r.network_access, status: r.status, driver: r.driver, isolated: r.driver === 'docker', egressFiltered: r.egress_filtered === true,
    nodeId: r.node_id, envKeys: r.env_keys ?? [], fromSnapshotId: r.from_snapshot_id, ttlSeconds: r.ttl_seconds,
    expiresAt: r.expires_at, execCount: r.exec_count, lastExecAt: r.last_exec_at, error: r.error, createdAt: r.created_at, stoppedAt: r.stopped_at,
  };
}

const R = '[REDACTED]';
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`;
const SECRET_NAME = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)`;

/**
 * The command as it goes into the audit log: obvious inline secrets are replaced (password / token flags,
 * SECRET-like VAR=value assignments, Authorization headers and bearer tokens, passwords in URLs, mysql -p...).
 * Best effort: the command is still recorded, so what was run stays visible.
 */
export function redactCommand(cmd: string): string {
  return cmd
    .replace(new RegExp(String.raw`(--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth-token|client-secret)(?:=|\s+))${VALUE}`, 'gi'), `$1${R}`)
    .replace(new RegExp(String.raw`\b(${SECRET_NAME})=${VALUE}`, 'gi'), `$1=${R}`)
    .replace(new RegExp(String.raw`(authorization:\s*(?:bearer|basic|token)?\s*)([^\s"']+)`, 'gi'), `$1${R}`)
    .replace(/\b(bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi, `$1${R}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`)
    // mysql-family clients take the password glued to -p; sshpass and redis-cli take it as the next word.
    .replace(/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^|;&\n]*?\s-p)(?!\s)(\S+)/gi, `$1${R}`)
    .replace(/(\bsshpass\s+-p\s*)(\S+)/gi, `$1${R}`)
    .replace(/(\bredis-cli\b[^|;&\n]*?\s-a\s+)(\S+)/gi, `$1${R}`);
}

export function sandboxSnapshotOut(r: Row): SandboxSnapshot {
  return {
    id: r.id, workspaceId: r.workspace_id, sandboxId: r.sandbox_id, name: r.name, runtime: r.runtime, image: r.image, status: r.status,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), error: r.error, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

export interface AgentNode { id: string; address: string; agent_port: number }

/** The live node with the fewest live sandboxes that offers the agent endpoint. */
export async function placeSandbox(): Promise<AgentNode | null> {
  return one<AgentNode>(
    `SELECT n.id, n.address, n.agent_port FROM nodes n
     WHERE n.agent_port IS NOT NULL AND NOT n.draining AND n.last_heartbeat > now() - make_interval(secs => $1)
     ORDER BY (SELECT count(*) FROM sandboxes s WHERE s.node_id = n.id AND s.status = ANY($2)), n.id LIMIT 1`,
    [NODE_TTL_S, LIVE],
  );
}

export async function nodeOf(sb: Row): Promise<AgentNode | null> {
  if (!sb.node_id) return null;
  return one<AgentNode>('SELECT id, address, agent_port FROM nodes WHERE id = $1 AND agent_port IS NOT NULL', [sb.node_id]);
}

export interface AgentCall {
  json?: unknown;
  body?: Buffer;
  query?: Record<string, string>;
  timeoutMs?: number;
}

/** Calls the node agent's private sandbox API. Network failures become 502s. */
export async function agentFetch(node: AgentNode, method: string, p: string, opts: AgentCall = {}): Promise<Response> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const headers: Record<string, string> = { authorization: `Bearer ${nodeToken()}` };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body) {
    headers['content-type'] = 'application/octet-stream';
    body = new Uint8Array(opts.body);
  }
  try {
    return await fetch(`http://${node.address}:${node.agent_port}${p}${qs}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  } catch (err) {
    throw new HttpError(502, 'node_unreachable', `could not reach the sandbox's node: ${(err as Error).message}`);
  }
}

/** Maps an agent error response to an API error (path problems, limits and conflicts keep their status). */
export async function agentError(res: Response): Promise<HttpError> {
  const text = await res.text().catch(() => '');
  let message = text;
  try { message = JSON.parse(text).error ?? text; } catch { /* plain text */ }
  if (res.status === 404) return new HttpError(404, 'not_found', message || 'not found');
  if ([400, 403, 409, 413, 429, 503].includes(res.status)) return new HttpError(res.status, res.status === 503 ? 'unavailable' : 'sandbox_error', message || res.statusText);
  return new HttpError(502, 'sandbox_error', `the sandbox's node failed: ${message || res.status}`);
}

export async function agentJson<T>(node: AgentNode, method: string, p: string, opts: AgentCall = {}): Promise<T> {
  const res = await agentFetch(node, method, p, opts);
  if (!res.ok) throw await agentError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/**
 * Stops a sandbox: the node kills its commands and removes its files; the row keeps its history. When the node
 * is gone the sandbox is gone with it, so the row is closed anyway.
 */
export async function teardownSandbox(sb: Row, status: 'stopped' | 'expired' | 'failed', error: string | null = null): Promise<Row> {
  const claimed = await one("UPDATE sandboxes SET status = 'stopping' WHERE id = $1 AND status IN ('starting','running','failed') RETURNING *", [sb.id]);
  if (claimed) {
    const node = await nodeOf(claimed);
    if (node) await agentFetch(node, 'DELETE', `/sandboxes/${sb.id}`, { timeoutMs: 30_000 }).catch(() => {});
  }
  const row = await one(
    `UPDATE sandboxes SET status = CASE WHEN status = 'failed' AND $2 = 'stopped' THEN 'failed' ELSE $2 END,
       error = COALESCE($3, error), stopped_at = COALESCE(stopped_at, now()) WHERE id = $1 RETURNING *`,
    [sb.id, status, error],
  );
  return row ?? sb;
}

/** TTL expiry and lost nodes. Runs on the scheduler; returns how many sandboxes were closed. */
export async function expireSandboxes(): Promise<number> {
  const due = await q("SELECT * FROM sandboxes WHERE status IN ('starting','running') AND expires_at <= now() ORDER BY expires_at LIMIT 200");
  for (const sb of due) await teardownSandbox(sb, 'expired').catch((err) => console.error('[sandboxes] expire', sb.id, (err as Error).message));
  // A node that stopped heart-beating took its sandboxes with it.
  const lost = await q(
    `UPDATE sandboxes s SET status = 'failed', error = 'the node running this sandbox is gone', stopped_at = now()
     FROM nodes n WHERE n.id = s.node_id AND s.status IN ('starting','running') AND n.last_heartbeat < now() - interval '5 minutes' RETURNING s.id`,
  );
  return due.length + lost.length;
}

/** Removes a snapshot's archive from this control plane's artifact store. */
export async function deleteSnapshotArchive(key: string): Promise<void> {
  const dir = path.join(config.dataDir, 'store', 'artifacts');
  await rm(path.join(dir, `${key}.tgz`), { force: true }).catch(() => {});
  await rm(path.join(dir, `${key}.json`), { force: true }).catch(() => {});
}
