import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('rounded-[4px] border border-border bg-surface', className)}>{children}</section>;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold tracking-[-0.005em] text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('p-5', className)}>{children}</div>;
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-start gap-3.5">
        {icon && <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[4px] border border-border bg-surface text-fg-muted">{icon}</div>}
        <div className="min-w-0">
          <h1 className="truncate text-[22px] leading-[1.2] font-semibold tracking-[-0.02em] text-fg md:text-[26px]">{title}</h1>
          {description && <p className="mt-1.5 max-w-[68ch] text-[13.5px] leading-[1.55] text-fg-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Two-column settings row: label/description on the left, control on the right. */
export function SettingRow({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-3 border-b border-border px-5 py-5 last:border-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-6', className)}>
      <div>
        <div className="text-[13.5px] font-medium text-fg">{title}</div>
        {description && <p className="mt-1 text-[13px] leading-[1.5] text-fg-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
