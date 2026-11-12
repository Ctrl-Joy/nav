// Installing the NAV GitHub App from the dashboard, and linking the installation to the workspace that asked for it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decrypt } from '@nav/shared/crypto';
import { config } from '@nav/shared/config';
import { one, q } from '../../db/pool.ts';
import { HttpError, badRequest, recordEvent } from '../../lib/core.ts';
import { appInstallation, githubAppEnabled, installationRepos, userRepos } from '../../lib/github.ts';
import { mayClaimInstallation, safeNext, signInstallState, verifyInstallState, withParam } from '../../lib/githubInstall.ts';
import { requireUser, workspaceRole } from '../auth.ts';

const masterKey = () => process.env.NAV_MASTER_KEY ?? '';

export async function githubAppRoutes(app: FastifyInstance) {
  // The dashboard's "Install app" link. A browser navigation, so it answers with a redirect to GitHub.
  app.get('/workspaces/:ws/github/install', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    const { next } = z.object({ next: z.string().optional() }).parse(req.query);
    await workspaceRole(req, ws, 'admin');
    if (!githubAppEnabled() || !config.github.appSlug) throw badRequest('the GitHub App is not configured on this NAV instance');
    const state = signInstallState(requireUser(req).id, ws, next ?? '', masterKey());
    return reply.redirect(`https://github.com/apps/${encodeURIComponent(config.github.appSlug)}/installations/new?state=${encodeURIComponent(state)}`);
  });

  // GitHub's Setup URL: where the browser lands after the install (or an update of it).
  app.get('/github/app/callback', async (req, reply) => {
    const query = z.object({ installation_id: z.coerce.number().int().positive().optional(), setup_action: z.string().optional(), state: z.string().optional() }).parse(req.query);
    if (!req.user) return reply.redirect('/login');
    const user = requireUser(req);
    const state = verifyInstallState(query.state, masterKey());
    // Without a valid state this was not started from NAV (for example an install from GitHub's own page).
    if (!state || state.u !== user.id) return reply.redirect('/app');
    const back = (result: string, message?: string) => {
      let path = withParam(safeNext(state.n, state.w), 'github', result);
      if (message) path = withParam(path, 'github_message', message);
      return reply.redirect(path);
    };

    try {
      await workspaceRole(req, state.w, 'admin');
      if (query.setup_action === 'request') return back('requested');
      if (!query.installation_id) return back('error', 'GitHub did not say which installation this was.');

      const inst = await appInstallation(query.installation_id);
      const row = await one<{ github_id: string | null; github_token_enc: string | null }>('SELECT github_id, github_token_enc FROM users WHERE id = $1', [user.id]);
      const githubUserId = row?.github_id != null ? Number(row.github_id) : null;
      let names: string[] = [];
      let mine: { fullName: string; admin: boolean }[] = [];
      if (inst.account.type !== 'User' && row?.github_token_enc) {
        names = (await installationRepos(inst.id)).map((r) => r.full_name);
        mine = (await userRepos(decrypt(row.github_token_enc))).map((r) => ({ fullName: r.full_name, admin: !!r.permissions?.admin }));
      }
      const verdict = mayClaimInstallation(inst, githubUserId, names, mine);
      if (!verdict.ok) return back('error', verdict.reason);

      // An installation lives in one workspace. Moving it is allowed only for someone who administers the workspace it is in now.
      const existing = await one<{ workspace_id: string | null }>('SELECT workspace_id FROM github_installations WHERE id = $1', [inst.id]);
      if (existing?.workspace_id && existing.workspace_id !== state.w) {
        const mayMove = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role IN (\'owner\',\'admin\')', [existing.workspace_id, user.id]);
        if (!mayMove) return back('error', 'This installation is already linked to another workspace.');
      }
      await q(
        'INSERT INTO github_installations (id, workspace_id, account_login, account_type) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type',
        [inst.id, state.w, inst.account.login, inst.account.type],
      );
      // Services created before the app was installed (or under an earlier installation) start using this one straight away.
      // Logins are letters, digits and hyphens only, so the owner can go into a LIKE pattern as it is.
      if (/^[a-z0-9-]+$/i.test(inst.account.login)) {
        await q(
          'UPDATE services SET installation_id = $1 WHERE workspace_id = $2 AND lower(repo_url) LIKE $3 AND installation_id IS DISTINCT FROM $1',
          [inst.id, state.w, `https://github.com/${inst.account.login.toLowerCase()}/%`],
        );
      }
      await recordEvent({ workspaceId: state.w, kind: 'github.app.linked', actorId: user.id, data: { installationId: inst.id, account: inst.account.login } }).catch(() => {});
      return back('installed');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      req.log.error(err);
      return back('error', 'Linking the installation failed. Try again, or contact your administrator.');
    }
  });
}
