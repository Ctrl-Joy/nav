// Inbound triggers: GitHub webhooks (push, pull_request, installation) and per-service deploy hooks.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { one, q } from '../../db/pool.ts';
import { HttpError, enqueue, notFound } from '../../lib/core.ts';
import * as ser from '../../lib/serialize.ts';
import { createDeploy } from '../../lib/deploys.ts';
import { createPreview, markForDeletion } from '../../lib/services.ts';
import { verifyWebhookSignature } from '../../lib/github.ts';
import { matchesBuildFilter } from '../../lib/filters.ts';
import { awaitChecks, eventVerdict, onChecksEvent } from '../../lib/checks.ts';
import { deletePreviewEnvironment, requestPreviewEnvironment } from '../../lib/previews.ts';

const norm = (url: string) => url.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/github', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifyWebhookSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) throw new HttpError(401, 'bad_signature', 'invalid webhook signature');
    const event = req.headers['x-github-event'] as string;
    const body = req.body as any;
    const repoUrl = body.repository?.html_url ? norm(body.repository.html_url) : null;

    if (event === 'ping') return { ok: true };

    if (event === 'installation' || event === 'installation_repositories') {
      const inst = body.installation;
      if (body.action === 'deleted') await q('DELETE FROM github_installations WHERE id = $1', [inst.id]);
      else {
        // Link the installation to every workspace of the NAV user whose GitHub account installed it.
        const users = await q('SELECT m.workspace_id FROM users u JOIN workspace_members m ON m.user_id = u.id WHERE u.github_id = $1 AND m.role IN (\'owner\',\'admin\')', [body.sender?.id]);
        for (const u of users.length ? users : [{ workspace_id: null }]) {
          await q('INSERT INTO github_installations (id, workspace_id, account_login, account_type) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET workspace_id = COALESCE(EXCLUDED.workspace_id, github_installations.workspace_id)', [inst.id, u.workspace_id, inst.account.login, inst.account.type]);
        }
      }
      return { ok: true };
    }

    if (event === 'push' && repoUrl) {
      if (!String(body.ref).startsWith('refs/heads/') || body.deleted) return { ok: true, skipped: 'not a branch push' };
      const branch = String(body.ref).slice('refs/heads/'.length);
      const head = body.head_commit;
      const message: string = head?.message ?? '';
      if (/\[(skip ci|ci skip|skip nav|nav skip)\]/i.test(message)) return { ok: true, skipped: 'skip marker in commit message' };
      const changedFiles: string[] = (body.commits ?? []).flatMap((c: any) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
      const svcs = await q("SELECT * FROM services WHERE lower(regexp_replace(repo_url, '\\.git$', '')) = $1 AND branch = $2 AND auto_deploy IN ('commit','checks') AND NOT suspended AND status <> 'deleting'", [repoUrl, branch]);
      const deploys = [];
      const waiting = [];
      for (const s of svcs) {
        if (!matchesBuildFilter(s.root_dir, s.build_filter, changedFiles)) continue;
        if (body.installation?.id && !s.installation_id) await q('UPDATE services SET installation_id = $2 WHERE id = $1', [s.id, body.installation.id]);
        const commit = { sha: body.after as string, message: message.split('\n')[0].slice(0, 500), author: head?.author?.name ?? head?.author?.username ?? null };
        if (s.auto_deploy === 'checks') {
          await awaitChecks(s, commit);
          waiting.push(s.id);
          continue;
        }
        const d = await createDeploy(s, { trigger: 'git_push', commitSha: commit.sha, commitMessage: commit.message, commitAuthor: commit.author });
        deploys.push(d.id);
      }
      const bps = await q('SELECT id FROM blueprints WHERE lower(repo_url) = $1 AND branch = $2 AND auto_sync', [repoUrl, branch]);
      for (const bp of bps) await enqueue('blueprint_sync', { blueprintId: bp.id }, { concurrencyKey: `bp:${bp.id}` });
      return { ok: true, deploys, waitingForChecks: waiting, blueprints: bps.length };
    }

    // CI results for a commit: deploy services that were waiting on them ('checks' auto-deploy).
    if ((event === 'check_suite' || event === 'check_run' || event === 'status') && repoUrl) {
      const v = eventVerdict(event, body);
      if (!v) return { ok: true, skipped: 'not a completed check' };
      return { ok: true, ...(await onChecksEvent(repoUrl, v.sha, body.installation?.id ?? null, v.verdict)) };
    }

    if (event === 'pull_request' && repoUrl) {
      const pr = body.pull_request;
      const base = pr.base.ref;
      const parents = await q("SELECT * FROM services WHERE lower(regexp_replace(repo_url, '\\.git$', '')) = $1 AND branch = $2 AND parent_service_id IS NULL AND previews->>'mode' <> 'off' AND status <> 'deleting'", [repoUrl, base]);
      for (const parent of parents) {
        if (['opened', 'reopened', 'synchronize'].includes(body.action)) {
          const automatic = parent.previews.mode === 'automatic';
          const labeled = (pr.labels ?? []).some((l: any) => l.name === 'nav-preview');
          const exists = await one('SELECT 1 FROM services WHERE parent_service_id = $1 AND pr_number = $2', [parent.id, pr.number]);
          if (!automatic && !labeled && !exists) continue;
          if (/\[(skip preview|preview skip)\]/i.test(pr.title ?? '')) continue;
          // The PR comment (one per preview, kept up to date) is written by the notifier from the deploy events.
          await createPreview(parent, pr.head.ref, pr.number, null, pr.head.sha);
        } else if (body.action === 'closed') {
          const previews = await q("SELECT * FROM services WHERE parent_service_id = $1 AND pr_number = $2 AND status <> 'deleting'", [parent.id, pr.number]);
          for (const p of previews) await markForDeletion(p, null);
        }
      }

      // Blueprint preview environments: the whole stack per PR.
      const bps = await q("SELECT * FROM blueprints WHERE lower(regexp_replace(repo_url, '\\.git$', '')) = $1 AND branch = $2 AND previews->>'generation' <> 'off'", [repoUrl, base]);
      for (const bp of bps) {
        const env = await one('SELECT * FROM preview_environments WHERE blueprint_id = $1 AND pr_number = $2', [bp.id, pr.number]);
        if (['opened', 'reopened', 'synchronize', 'labeled'].includes(body.action)) {
          const labeled = (pr.labels ?? []).some((l: any) => l.name === 'nav-preview');
          if (bp.previews.generation !== 'automatic' && !labeled && !env) continue;
          if (body.action === 'labeled' && env) continue;
          if (/\[(skip preview|preview skip)\]/i.test(pr.title ?? '')) continue;
          await requestPreviewEnvironment(bp, { number: pr.number, title: pr.title ?? null, headRef: pr.head.ref, headSha: pr.head.sha ?? null });
        } else if (body.action === 'closed' && env) {
          await deletePreviewEnvironment(env, null);
        }
      }
      return { ok: true };
    }
    return reply.status(202).send({ ok: true, ignored: event });
  });

  // Deploy hook: POST /deploy-hooks/:serviceId?key=...&ref=<sha>&imgURL=<image>
  app.all('/deploy-hooks/:serviceId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (req.method !== 'POST' && req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'use POST');
    const { serviceId } = req.params as { serviceId: string };
    const { key, ref, imgURL } = req.query as { key?: string; ref?: string; imgURL?: string };
    const svc = await one("SELECT * FROM services WHERE id = $1 AND status <> 'deleting'", [serviceId]);
    const ok = svc && key && key.length === svc.deploy_hook_token.length && timingSafeEqual(Buffer.from(key), Buffer.from(svc.deploy_hook_token));
    if (!ok) throw notFound('deploy hook');
    if (ref && !/^[0-9a-f]{7,40}$/.test(ref)) throw new HttpError(400, 'bad_request', 'ref must be a commit sha');
    if (imgURL && svc.runtime !== 'image') throw new HttpError(400, 'bad_request', 'imgURL is only valid for image-backed services');
    const dep = await createDeploy(svc, { trigger: 'deploy_hook', commitSha: ref ?? null, imageUrl: imgURL ?? null });
    return reply.status(201).send({ deploy: ser.deploy(dep) });
  });
}
