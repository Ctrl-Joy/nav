// Pull-request previews: blueprint preview environments (a copy of the whole stack per PR) and the PR comment
// that reports a preview's URL and status.
import { config, publicUrlFor } from '@nav/shared/config';
import { id } from '@nav/shared/ids';
import { one, q, type Row } from '../db/pool.ts';
import { changed, enqueue, recordEvent } from './core.ts';
import { deleteResources, type TrackedResource } from './blueprints.ts';
import { githubAppEnabled, previewCommentBody, upsertPrComment, type PreviewCommentRow } from './github.ts';

/** `untrusted`: the PR comes from a fork; its copies get no values from the blueprint's own services. */
export interface PullRequestRef { number: number; title: string | null; headRef: string; headSha: string | null; untrusted?: boolean }

/** Creates (or refreshes at a new head) the preview environment of a blueprint for a PR; the agent builds it. */
export async function requestPreviewEnvironment(bp: Row, pr: PullRequestRef): Promise<Row> {
  // Once untrusted, always untrusted (OR on conflict): a fork never inherits an environment made for trusted code.
  const env = (await one(
    `INSERT INTO preview_environments (id, blueprint_id, workspace_id, pr_number, pr_title, branch, commit_sha, untrusted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (blueprint_id, pr_number) DO UPDATE SET pr_title = EXCLUDED.pr_title, branch = EXCLUDED.branch, commit_sha = EXCLUDED.commit_sha,
       untrusted = preview_environments.untrusted OR EXCLUDED.untrusted, status = 'creating', error = NULL, updated_at = now()
     RETURNING *`,
    [id('bpv'), bp.id, bp.workspace_id, pr.number, pr.title?.slice(0, 300) ?? null, pr.headRef, pr.headSha, !!pr.untrusted],
  ))!;
  await enqueue('blueprint_preview', { previewId: env.id }, { concurrencyKey: `bpv:${env.id}` });
  await recordEvent({ workspaceId: bp.workspace_id, kind: 'preview_environment_requested', data: { blueprintId: bp.id, previewId: env.id, prNumber: pr.number } });
  await changed(bp.workspace_id, 'blueprint', bp.id);
  return env;
}

/** Deletes every resource of a preview environment, then the environment itself. */
export async function deletePreviewEnvironment(env: Row, actorId: string | null): Promise<void> {
  // Remove the row first so a build still in progress stops (its next track() call finds no row and cleans up).
  await q('DELETE FROM preview_environments WHERE id = $1', [env.id]);
  await deleteResources(env.resources as TrackedResource[], actorId);
  await recordEvent({ workspaceId: env.workspace_id, actorId, kind: 'preview_environment_deleted', data: { blueprintId: env.blueprint_id, previewId: env.id, prNumber: env.pr_number } });
  await changed(env.workspace_id, 'blueprint', env.blueprint_id);
}

/** Preview environments idle for longer than their blueprint's expireAfterDays (0 = never expire). */
export async function expirePreviewEnvironments(): Promise<number> {
  const stale = await q(
    `SELECT pe.* FROM preview_environments pe JOIN blueprints b ON b.id = pe.blueprint_id
     WHERE COALESCE((b.previews->>'expireAfterDays')::int, 7) > 0
       AND pe.updated_at < now() - make_interval(days => COALESCE((b.previews->>'expireAfterDays')::int, 7))`,
  );
  for (const env of stale) await deletePreviewEnvironment(env, null);
  return stale.length;
}

export function previewEnvironment(r: Row, services: Row[] = []) {
  return {
    id: r.id,
    blueprintId: r.blueprint_id,
    prNumber: r.pr_number,
    prTitle: r.pr_title,
    branch: r.branch,
    commitSha: r.commit_sha,
    status: r.status,
    error: r.error,
    resources: (r.resources as TrackedResource[]).map((x) => {
      const s = services.find((svc) => svc.id === x.id);
      return { ...x, status: s?.status ?? null, url: s && ['web', 'static'].includes(s.type) ? publicUrlFor(s.slug) : null };
    }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The deploy-centric status shown in the PR comment: the latest deploy decides. */
async function commentRow(svc: Row): Promise<PreviewCommentRow> {
  const dep = await one('SELECT status FROM deploys WHERE service_id = $1 ORDER BY created_at DESC LIMIT 1', [svc.id]);
  const s = dep?.status as string | undefined;
  const status = svc.status === 'deleting' ? 'deleting' : s === 'live' ? 'live' : s?.endsWith('_failed') ? 'failed' : s === 'canceled' ? 'canceled' : 'deploying';
  return {
    name: svc.name,
    status,
    url: ['web', 'static'].includes(svc.type) ? publicUrlFor(svc.slug) : null,
    dashboardUrl: `${config.dashboardUrl}/w/${svc.workspace_id}/services/${svc.id}`,
  };
}

/**
 * Creates or updates the one PR comment for the preview a service belongs to (its preview environment, or the
 * single-service preview). Runs on the control plane from the event stream, so agents need no GitHub credentials.
 * A no-op without a GitHub App or when the service is not a preview.
 */
export async function syncPreviewComment(serviceId: string): Promise<void> {
  if (!githubAppEnabled()) return;
  const svc = await one('SELECT * FROM services WHERE id = $1', [serviceId]);
  if (!svc) return;
  const env = await one(
    'SELECT pe.*, b.repo_url, b.name AS blueprint_name FROM preview_environments pe JOIN blueprints b ON b.id = pe.blueprint_id WHERE pe.resources @> $1::jsonb',
    [JSON.stringify([{ id: serviceId }])],
  );
  if (env) {
    const ids = (env.resources as TrackedResource[]).filter((r) => r.type === 'service').map((r) => r.id);
    const svcs = await q('SELECT * FROM services WHERE id = ANY($1) ORDER BY name', [ids]);
    const installation = svcs.find((s) => s.installation_id)?.installation_id ?? null;
    const rows = await Promise.all(svcs.map(commentRow));
    await upsertPrComment(installation ? Number(installation) : null, env.repo_url, env.pr_number, `<!-- nav-preview-env:${env.id} -->`, previewCommentBody(`${env.blueprint_name} (preview environment)`, rows));
    return;
  }
  if (!svc.parent_service_id || !svc.pr_number || !svc.repo_url) return;
  const parent = await one('SELECT name, installation_id FROM services WHERE id = $1', [svc.parent_service_id]);
  const installation = svc.installation_id ?? parent?.installation_id ?? null;
  await upsertPrComment(installation ? Number(installation) : null, svc.repo_url, svc.pr_number, `<!-- nav-preview:${svc.id} -->`, previewCommentBody(parent?.name ?? svc.name, [await commentRow(svc)]));
}
