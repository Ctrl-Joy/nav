import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { qk } from '@/api/keys';
import { useToast } from '@/components/ui';

/**
 * Where the "Install app" buttons go. The control plane signs a state that ties the install to this user and workspace, sends the
 * browser to GitHub, and brings it back to `next` once the installation is linked.
 */
export function githubInstallUrl(ws: string, next: string): string {
  return `/api/v1/workspaces/${ws}/github/install?next=${encodeURIComponent(next)}`;
}

/** Shows the outcome of an install (the redirect adds ?github=installed|requested|error) and refreshes the repository list. */
export function useGithubInstallResult(ws: string) {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const result = params.get('github');
  const message = params.get('github_message');
  useEffect(() => {
    if (!result) return;
    if (result === 'installed') toast.success('GitHub app connected', 'Pushes to your repositories now deploy automatically.');
    else if (result === 'requested') toast.success('Install requested', 'An owner of that GitHub organisation has to approve it. Come back after they do.');
    else if (result === 'error') toast.error('Could not connect the GitHub app', message ?? undefined);
    void qc.invalidateQueries({ queryKey: qk.repos(ws) });
    const next = new URLSearchParams(params);
    next.delete('github');
    next.delete('github_message');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
}
