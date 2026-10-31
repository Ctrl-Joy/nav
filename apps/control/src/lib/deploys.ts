import { id } from '@nav/shared/ids';
import type { DeployTrigger } from '@nav/shared';
import { one, q, tx, type Row } from '../db/pool.ts';
import { badRequest, changed, conflict, enqueue, log, recordEvent } from './core.ts';
import { lsRemote } from './git.ts';

export interface DeployRequest {
  trigger: DeployTrigger;
  actorId?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  clearCache?: boolean;
  rollbackOf?: string | null;
  imageUrl?: string | null;
}

/** Queues a deploy for a service. A newer deploy supersedes older queued (not yet started) ones. */
export async function createDeploy(svc: Row, req: DeployRequest): Promise<Row> {
  if (svc.suspended && req.trigger !== 'manual' && req.trigger !== 'rollback') throw conflict('service is suspended');
  let artifact = null;
  let commitSha = req.commitSha ?? null;
  let commitMessage = req.commitMessage ?? null;
  let commitAuthor = req.commitAuthor ?? null;

  if (req.rollbackOf) {
    const prev = await one('SELECT * FROM deploys WHERE id = $1 AND service_id = $2', [req.rollbackOf, svc.id]);
    if (!prev) throw badRequest('deploy to roll back to not found');
    if (!prev.artifact) throw badRequest('that deploy has no build artifact (it never built successfully)');
    artifact = prev.artifact;
    commitSha = prev.commit_sha;
    commitMessage = prev.commit_message;
    commitAuthor = prev.commit_author;
  } else if (svc.repo_url && !commitSha) {
    // Resolve the branch head now so the deploy row shows the commit immediately.
    try {
      const { heads } = await lsRemote(svc.repo_url, svc.installation_id ? Number(svc.installation_id) : null);
      commitSha = heads.get(svc.branch) ?? null;
      if (!commitSha) throw badRequest(`branch "${svc.branch}" not found in ${svc.repo_url}`);
    } catch (err) {
      if ((err as { status?: number }).status === 400) throw err;
    }
  }
  if (commitSha && !/^[0-9a-f]{7,40}$/.test(commitSha)) throw badRequest('invalid commit sha');

  const deployId = id('dep');
  const row = await tx(async (c) => {
    // Supersede queued deploys that have not started yet.
    const superseded = await c.query(
      "UPDATE deploys SET status = 'canceled', finished_at = now(), error = 'superseded by a newer deploy' WHERE service_id = $1 AND status = 'queued' RETURNING id",
      [svc.id],
    );
    if (superseded.rowCount) await c.query("UPDATE jobs SET status = 'canceled' WHERE kind = 'deploy' AND status = 'queued' AND payload->>'deployId' = ANY($1)", [superseded.rows.map((r) => r.id)]);
    const ins = await c.query(
      `INSERT INTO deploys (id, service_id, status, trigger, commit_sha, commit_message, commit_author, branch, clear_cache, rollback_of, artifact, created_by, config)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [deployId, svc.id, req.trigger, commitSha, commitMessage, commitAuthor, svc.branch, req.clearCache ?? false, req.rollbackOf ?? null, artifact, req.actorId ?? null,
        { imageUrl: req.imageUrl ?? svc.image_url }],
    );
    await c.query("UPDATE services SET status = CASE WHEN status = 'live' THEN 'live' ELSE 'deploying' END, updated_at = now() WHERE id = $1", [svc.id]);
    await enqueue('deploy', { deployId, serviceId: svc.id }, { concurrencyKey: `svc:${svc.id}`, client: c });
    return ins.rows[0];
  });
  await log({ serviceId: svc.id, deployId, stream: 'deploy', message: `==> Deploy ${deployId} queued (trigger: ${req.trigger}${commitSha ? `, commit ${commitSha.slice(0, 7)}` : ''})` });
  await recordEvent({ workspaceId: svc.workspace_id, serviceId: svc.id, actorId: req.actorId, kind: req.rollbackOf ? 'rollback_started' : 'deploy_started', data: { deployId, trigger: req.trigger, commitSha, rollbackOf: req.rollbackOf ?? null } });
  await changed(svc.workspace_id, 'deploy', deployId, svc.id);
  return row;
}

export async function cancelDeploy(dep: Row, workspaceId: string, actorId: string): Promise<void> {
  if (!['queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress'].includes(dep.status)) throw conflict(`deploy is ${dep.status}`);
  await q("UPDATE deploys SET status = 'canceled', finished_at = now(), error = 'canceled by user' WHERE id = $1", [dep.id]);
  await q("UPDATE jobs SET status = 'canceled' WHERE kind = 'deploy' AND status = 'queued' AND payload->>'deployId' = $1", [dep.id]);
  await log({ serviceId: dep.service_id, deployId: dep.id, stream: 'deploy', level: 'warn', message: '==> Deploy canceled' });
  await recordEvent({ workspaceId, serviceId: dep.service_id, actorId, kind: 'deploy_canceled', data: { deployId: dep.id } });
}

/** Enqueue a node-level operation on a service (stop, scale, restart) serialized with its deploys. */
export async function serviceOp(svc: Row, kind: 'stop_service' | 'scale' | 'restart', payload: Record<string, unknown> = {}): Promise<void> {
  await enqueue(kind, { serviceId: svc.id, ...payload }, { concurrencyKey: `svc:${svc.id}` });
}
