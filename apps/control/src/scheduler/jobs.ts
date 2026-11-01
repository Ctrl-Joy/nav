// Jobs the control plane runs itself rather than an agent: domain verification and certificate issuance need the
// edge's files (local CA in development, the ACME account) and nothing from a node.
import os from 'node:os';
import { pool, q } from '../db/pool.ts';
import { issueCertificate, verifyDomain } from '../lib/domains.ts';
import { PLATFORM_CERT_JOB, issuePlatformCertificate } from '../lib/platformTls.ts';

export const CONTROL_JOBS = ['verify_domain', 'issue_cert', PLATFORM_CERT_JOB];

const HANDLERS: Record<string, (payload: any) => Promise<void>> = {
  verify_domain: (p) => verifyDomain(p.domainId),
  issue_cert: (p) => issueCertificate(p.domainId, (m) => console.log(`[acme] ${m}`)),
  [PLATFORM_CERT_JOB]: () => issuePlatformCertificate(),
};

const worker = `control:${os.hostname()}:${process.pid}`;

async function claim(): Promise<{ id: number; kind: string; payload: any; attempts: number; max_attempts: number } | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND kind = ANY($2)
                 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind, payload, attempts, max_attempts`,
    [worker, CONTROL_JOBS],
  );
  return rows[0] ?? null;
}

export function startControlJobs(): void {
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let job = await claim(); job; job = await claim()) {
        try {
          await HANDLERS[job.kind](job.payload);
          await q("UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1", [job.id]);
        } catch (err) {
          const retry = job.attempts < job.max_attempts;
          console.error(`[control] job ${job.id} ${job.kind} failed:`, (err as Error).message);
          await q(
            `UPDATE jobs SET status = $2, error = $3, locked_by = NULL, finished_at = CASE WHEN $2 = 'failed' THEN now() END,
               run_at = now() + make_interval(secs => $4) WHERE id = $1`,
            [job.id, retry ? 'queued' : 'failed', (err as Error).message.slice(0, 2000), 30 * job.attempts],
          );
        }
      }
    } catch (err) {
      console.error('[control] job loop:', (err as Error).message);
    } finally {
      busy = false;
    }
  };
  setInterval(() => void loop(), 1000);
  void loop();
}
