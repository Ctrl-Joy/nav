import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

interface TriggerProps {
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

const CloseContext = createContext<() => void>(() => {});

export function Dropdown({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  width = 'w-56',
  className,
}: {
  trigger: (props: TriggerProps & { open: boolean }) => ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  width?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) (wrapRef.current?.querySelector('[aria-haspopup="menu"]') as HTMLElement | null)?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    requestAnimationFrame(() => items()[0]?.focus());
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const idx = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(idx + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(idx - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className={cn('relative inline-flex', className)}>
      {trigger({
        open,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        },
      })}
      {open && (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          onKeyDown={onMenuKey}
          className={cn(
            'absolute z-50 animate-fade-in rounded-lg border border-border bg-bg-elevated p-1 shadow-pop',
            side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
            align === 'end' ? 'right-0' : 'left-0',
            width,
          )}
        >
          <CloseContext.Provider value={() => close(false)}>{children}</CloseContext.Provider>
        </div>
      )}
    </div>
  );
}

const itemClass = (danger?: boolean, disabled?: boolean) =>
  cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none',
    danger ? 'text-danger focus:bg-danger-soft hover:bg-danger-soft' : 'text-fg focus:bg-surface-2 hover:bg-surface-2',
    disabled && 'pointer-events-none opacity-50',
  );

export function DropdownItem({
  onSelect,
  icon,
  children,
  hint,
  danger,
  disabled,
  to,
}: {
  onSelect?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  to?: string;
}) {
  const close = useContext(CloseContext);
  const content = (
    <>
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
    </>
  );
  if (to) {
    return (
      <Link role="menuitem" tabIndex={-1} to={to} className={itemClass(danger, disabled)} aria-disabled={disabled || undefined} onClick={() => close()}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      className={itemClass(danger, disabled)}
      onClick={() => {
        if (disabled) return;
        close();
        onSelect?.();
      }}
    >
      {content}
    </button>
  );
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{children}</div>;
}

export function DropdownSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}
