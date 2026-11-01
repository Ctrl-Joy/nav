import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from '@/api/auth';
import { FullPageSpinner } from '@/layouts/RootLayout';
import { LAST_WORKSPACE_KEY, readLocal } from '@/lib/misc';
import { Empty } from '@/components/ui';

/** `/app` → last used workspace, else the first one. */
export function AppRedirect({ suffix = '' }: { suffix?: string }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageSpinner />;
  const workspaces = me.data?.workspaces ?? [];
  if (!workspaces.length) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Empty title="No workspaces yet" description="Your account is not a member of any NAV workspace. Ask a teammate to invite you." />
      </div>
    );
  }
  const last = readLocal(LAST_WORKSPACE_KEY);
  const target = workspaces.find((w) => w.id === last) ?? workspaces[0];
  return <Navigate to={`/w/${target.id}${suffix}${suffix ? location.search + location.hash : ''}`} replace />;
}

/** `/account` (used by OAuth callbacks, which don't know the workspace) → account settings in the current workspace. */
export function AccountRedirect() {
  return <AppRedirect suffix="/account" />;
}
