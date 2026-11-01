import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number;
}

const tabClass = (active: boolean) =>
  cn(
    'relative -mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-[14px] transition-colors',
    active ? 'border-accent-strong font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg',
  );

function onArrowKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const idx = tabs.indexOf(document.activeElement as HTMLElement);
  if (idx < 0) return;
  e.preventDefault();
  const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
}

/** Local-state tabs. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  label = 'Tabs',
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} role="tablist" aria-label={label} onKeyDown={onArrowKeys} className={cn('flex gap-5 overflow-x-auto border-b border-border', className)}>
      {items.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          className={tabClass(value === t.value)}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-[3px] bg-surface-3 px-1.5 font-mono text-[11px] text-fg-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Route-driven tabs (each tab is a link). */
export function RouteTabs({ items, className, label = 'Sections' }: { items: { to: string; label: ReactNode; end?: boolean }[]; className?: string; label?: string }) {
  return (
    <nav aria-label={label} className={cn('flex gap-5 overflow-x-auto border-b border-border', className)}>
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => tabClass(isActive)}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
