// The agent's side of the job queue: which jobs a node may claim, in three lanes with separate concurrency.
import { pool } from '../db/pool.ts';
import { CONTROL_JOBS } from '../scheduler/jobs.ts';
import { RUN_JOB } from '../lib/workflows.ts';

/** Instance start/stop and cleanup jobs run in their own lane: deploys elsewhere wait on them, so they must
 *  never queue behind those deploys. */
export const NODE_LANE = ['instance_start', 'instance_stop', 'node_cleanup'];
/** Workflow runs have their own lane so a burst of runs (fan-out) never delays deploys, and vice versa. */
export const WORKFLOW_LANE = [RUN_JOB];
export type Lane = 'work' | 'node' | 'workflow';

export interface ClaimedJob { id: number; kind: string; payload: any; attempts: number; max_attempts: number }

/**
 * Atomically claims the next runnable job of a lane, honouring per-key concurrency. A job naming a node is only
 * claimed by that node; database jobs follow the node that holds the database; a draining node takes no new
 * untargeted work. Workflow runs also respect their workflow's max concurrency (running runs, cluster-wide).
 */
export async function claim(nid: string, lane: Lane, draining: boolean): Promise<ClaimedJob | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(77001)');
    const res = await c.query(
      `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT j.id FROM jobs j WHERE j.status = 'queued' AND j.run_at <= now()
           AND (CASE $2::text WHEN 'node' THEN j.kind = ANY($3) WHEN 'workflow' THEN j.kind = ANY($4) ELSE NOT (j.kind = ANY($3) OR j.kind = ANY($4)) END)
           AND NOT (j.kind = ANY($6))
           AND (j.node_id = $1 OR (j.node_id IS NULL AND NOT $5))
           AND NOT (j.kind LIKE 'kv\\_%' AND EXISTS (SELECT 1 FROM key_values k WHERE k.id = j.payload->>'keyValueId' AND k.node_id IS NOT NULL AND k.node_id <> $1))
           AND NOT (j.kind LIKE 'db\\_%' AND EXISTS (SELECT 1 FROM databases d WHERE d.id = j.payload->>'databaseId' AND d.node_id IS NOT NULL AND d.node_id <> $1))
           AND (j.concurrency_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.concurrency_key = j.concurrency_key))
           AND NOT (j.kind = '${RUN_JOB}' AND (
             SELECT count(*) FROM jobs r WHERE r.status = 'running' AND r.kind = '${RUN_JOB}' AND r.payload->>'serviceId' = j.payload->>'serviceId'
           ) >= COALESCE((SELECT s.workflow_concurrency FROM services s WHERE s.id = j.payload->>'serviceId'), 10))
         ORDER BY j.id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [nid, lane, NODE_LANE, WORKFLOW_LANE, draining, CONTROL_JOBS],
    );
    await c.query('COMMIT');
    return res.rows[0] ?? null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
