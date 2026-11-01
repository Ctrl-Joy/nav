import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton h-4', className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn('overflow-hidden rounded-[3px] border border-border-strong bg-surface', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border px-3 py-3.5 last:border-0">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="ml-auto h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-3 rounded-[3px] border border-border-strong bg-surface p-4', className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}
