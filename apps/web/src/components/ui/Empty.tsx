import type { ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export function Empty({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[3px] bg-panel text-center',
        compact ? 'px-4 py-10' : 'px-6 py-20',
        className,
      )}
    >
      {icon && <div className="mb-4 flex size-8 items-center justify-center text-fg [&_svg]:size-6">{icon}</div>}
      <h3 className="text-[17px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-[14px] text-fg-muted">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-center rounded-[3px] border border-danger/30 bg-danger-soft px-6 py-10 text-center', className)}>
      <AlertTriangle className="mb-2 size-5 text-danger" />
      <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-md text-[13px] text-fg-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" icon={<RotateCw className="size-3.5" />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
