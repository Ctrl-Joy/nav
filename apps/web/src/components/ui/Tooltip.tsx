import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** CSS-only tooltip: shows on hover and keyboard focus within; described-by for AT. */
export function Tooltip({ content, children, side = 'top', className }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom'; className?: string }) {
  const id = useId();
  return (
    <span className={cn('group/tt relative inline-flex', className)} aria-describedby={id}>
      {children}
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg opacity-0 shadow-pop transition-opacity delay-150',
          'group-hover/tt:opacity-100 group-focus-within/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  );
}
