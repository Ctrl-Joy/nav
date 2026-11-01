// Cross-cutting helpers: errors, activity events, change notifications, job queue.
import { notify, q, one, type Client } from '../db/pool.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'insufficient permissions') => new HttpError(403, 'forbidden', msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

export type Entity = 'service' | 'deploy' | 'database' | 'key_value' | 'instance' | 'run' | 'workflow_run' | 'domain' | 'blueprint' | 'env_group' | 'project';

/** Tell dashboards something changed (fan-out via LISTEN nav_changes). */
export async function changed(workspaceId: string, entity: Entity, id: string, serviceId?: string | null): Promise<void> {
  await notify('nav_changes', { workspaceId, entity, id, serviceId: serviceId ?? null }).catch(() => {});
}

export async function recordEvent(e: {
  workspaceId: string;
  serviceId?: string | null;
  databaseId?: string | null;
  actorId?: string | null;
  kind: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  await q(
    'INSERT INTO events (workspace_id, service_id, database_id, actor_id, kind, data) VALUES ($1,$2,$3,$4,$5,$6)',
    [e.workspaceId, e.serviceId ?? null, e.databaseId ?? null, e.actorId ?? null, e.kind, e.data ?? {}],
  );
  await changed(e.workspaceId, e.serviceId ? 'service' : e.databaseId ? 'database' : 'project', e.serviceId ?? e.databaseId ?? '', e.serviceId);
}

export interface EnqueueOptions {
  concurrencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  /** Only this node's agent may claim the job (instance lifecycle, local cleanup). */
  nodeId?: string;
  client?: Client;
}

export async function enqueue(kind: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<number> {
  const sql = 'INSERT INTO jobs (kind, payload, concurrency_key, run_at, max_attempts, node_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id';
  const params = [kind, payload, opts.concurrencyKey ?? null, opts.runAt ?? new Date(), opts.maxAttempts ?? 1, opts.nodeId ?? null];
  const row = opts.client ? (await opts.client.query(sql, params)).rows[0] : await one(sql, params);
  return row!.id;
}

/** Writes a log line from the control plane (e.g. "Deploy triggered by ..."). */
export async function log(line: { serviceId?: string | null; databaseId?: string | null; deployId?: string | null; runId?: string | null; stream: string; level?: string; message: string }): Promise<void> {
  const row = await one<{ id: number }>(
    'INSERT INTO logs (service_id, database_id, deploy_id, run_id, stream, level, message) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [line.serviceId ?? null, line.databaseId ?? null, line.deployId ?? null, line.runId ?? null, line.stream, line.level ?? 'info', line.message],
  );
  await notify('nav_logs', { id: row!.id, serviceId: line.serviceId ?? null, databaseId: line.databaseId ?? null, deployId: line.deployId ?? null, runId: line.runId ?? null }).catch(() => {});
}
