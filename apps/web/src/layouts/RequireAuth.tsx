import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '@/api/auth';
import { ErrorState } from '@/components/ui/Empty';
import { FullPageSpinner } from './RootLayout';

export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageSpinner />;
  if (me.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <ErrorState className="w-full max-w-lg" title="Cannot reach NAV" error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}
