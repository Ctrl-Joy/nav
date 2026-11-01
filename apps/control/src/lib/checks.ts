// Auto-deploy "after CI checks pass": a push to a service with auto_deploy = 'checks' is parked in
// pending_check_deploys and deployed once every status / check run of that commit has passed.
import { one, q, type Row } from '../db/pool.ts';
import { log, recordEvent } from './core.ts';
import { createDeploy } from './deploys.ts';
import { commitChecks, evaluateChecks, githubAppEnabled } from './github.ts';

export interface PendingCommit { sha: string; message: string | null; author: string | null }

/** Parks a pushed commit (replacing an older pending one) until its checks finish. */
export async function awaitChecks(svc: Row, commit: PendingCommit): Promise<void> {
  await q(
    `INSERT INTO pending_check_deploys (service_id, commit_sha, commit_message, commit_author) VALUES ($1,$2,$3,$4)
     ON CONFLICT (service_id) DO UPDATE SET commit_sha = EXCLUDED.commit_sha, commit_message = EXCLUDED.commit_message, commit_author = EXCLUDED.commit_author, created_at = now()`,
    [svc.id, commit.sha, commit.message, commit.author],
  );
  await log({ serviceId: svc.id, stream: 'deploy', message: `==> Commit ${commit.sha.slice(0, 7)} pushed; waiting for CI checks to pass before deploying` });
  await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, kind: 'deploy_waiting_for_checks', data: { commitSha: commit.sha } });
}

/**
 * Called for check_suite / check_run / status webhooks. `hint` is the verdict carried by the event itself, used
 * only when the GitHub App cannot be asked for the full picture (no App configured or no installation).
 */
export async function onChecksEvent(repoUrl: string, sha: string, installationId: number | null, hint: 'success' | 'pending' | 'failure'): Promise<{ deployed: string[]; skipped: string[] }> {
  const pending = await q(
    `SELECT s.*, p.commit_sha AS pending_sha, p.commit_message AS pending_message, p.commit_author AS pending_author
     FROM pending_check_deploys p JOIN services s ON s.id = p.service_id
     WHERE p.commit_sha = $1 AND lower(regexp_replace(s.repo_url, '\\.git$', '')) = $2 AND s.auto_deploy = 'checks'`,
    [sha, repoUrl],
  );
  const out = { deployed: [] as string[], skipped: [] as string[] };
  if (!pending.length) return out;
  const inst = installationId ?? (pending.find((s) => s.installation_id)?.installation_id as number | undefined) ?? null;
  let verdict = hint;
  if (inst && githubAppEnabled()) {
    const { statuses, runs } = await commitChecks(Number(inst), repoUrl, sha);
    verdict = evaluateChecks(statuses, runs);
  }
  if (verdict === 'pending') return out;
  for (const svc of pending) {
    // Claim the row so concurrent check events never deploy (or skip) the same commit twice.
    const claimed = await one('DELETE FROM pending_check_deploys WHERE service_id = $1 AND commit_sha = $2 RETURNING service_id', [svc.id, sha]);
    if (!claimed) continue;
    if (verdict === 'success') {
      if (svc.suspended || svc.status === 'deleting') continue;
      const d = await createDeploy(svc, { trigger: 'git_push', commitSha: sha, commitMessage: svc.pending_message, commitAuthor: svc.pending_author });
      out.deployed.push(d.id);
    } else {
      await log({ serviceId: svc.id, stream: 'deploy', level: 'warn', message: `==> Not deploying ${sha.slice(0, 7)}: CI checks failed` });
      await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, kind: 'deploy_skipped_checks_failed', data: { commitSha: sha } });
      out.skipped.push(svc.id);
    }
  }
  return out;
}

/** The verdict a single webhook payload carries on its own (fallback when the API cannot be queried). */
export function eventVerdict(event: string, body: any): { sha: string; verdict: 'success' | 'pending' | 'failure' } | null {
  const pass = (c: string | null | undefined) => (['success', 'neutral', 'skipped'].includes(c ?? '') ? 'success' : 'failure');
  if (event === 'check_suite' && body.action === 'completed' && body.check_suite?.head_sha) return { sha: body.check_suite.head_sha, verdict: pass(body.check_suite.conclusion) };
  if (event === 'check_run' && body.action === 'completed' && body.check_run?.head_sha) return { sha: body.check_run.head_sha, verdict: pass(body.check_run.conclusion) };
  if (event === 'status' && body.sha && body.context !== 'NAV') {
    return { sha: body.sha, verdict: body.state === 'success' ? 'success' : body.state === 'pending' ? 'pending' : 'failure' };
  }
  return null;
}
