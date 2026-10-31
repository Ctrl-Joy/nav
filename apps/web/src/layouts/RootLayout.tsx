import { isRouteErrorResponse, Link, Outlet, ScrollRestoration, useLocation, useRouteError } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LogoMark } from '@/components/Logo';
import { buttonClass } from '@/components/ui/Button';
import { NotFoundPage } from '@/pages/NotFound';

export function RootLayout() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Outlet />
      <ScrollRestoration />
    </ErrorBoundary>
  );
}

export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  const message = error instanceof Error ? error.message : isRouteErrorResponse(error) ? error.statusText : 'Unknown error';
  const chunkError = /dynamically imported module|Failed to fetch/i.test(message);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg p-6 text-center">
      <LogoMark className="size-10" />
      <h1 className="text-lg font-semibold">{chunkError ? 'NAV was updated' : 'Something went wrong'}</h1>
      <p className="max-w-md text-[13px] text-fg-muted">{chunkError ? 'A newer version of the dashboard is available. Reload to continue.' : message}</p>
      <div className="flex gap-2">
        <button className={buttonClass('primary')} onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link className={buttonClass('secondary')} to="/app">
          Dashboard
        </Link>
      </div>
    </div>
  );
}

export function FullPageSpinner({ label = 'Loading NAV' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg" role="status" aria-label={label}>
      <LogoMark className="size-10 animate-pulse-dot" />
    </div>
  );
}
