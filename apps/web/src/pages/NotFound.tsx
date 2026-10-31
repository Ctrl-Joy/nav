import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { buttonClass } from '@/components/ui/Button';
import { useTitle } from '@/lib/useTitle';

export function NotFoundPage() {
  useTitle('Not found');
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <div className="relative mb-6">
        <div className="bg-grid absolute -inset-10 rounded-full opacity-60 [mask-image:radial-gradient(closest-side,black,transparent)]" />
        <Compass className="relative size-12 text-accent" strokeWidth={1.4} />
      </div>
      <p className="font-mono text-xs tracking-[0.3em] text-fg-subtle">ERROR 404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Off the map</h1>
      <p className="mt-2 max-w-sm text-[13px] text-fg-muted">NAV couldn’t find a route to this page. It may have moved, or the resource was deleted.</p>
      <div className="mt-6 flex gap-2">
        <Link to="/app" className={buttonClass('primary')}>
          Go to dashboard
        </Link>
        <Link to="/" className={buttonClass('secondary')}>
          Home
        </Link>
      </div>
    </div>
  );
}
