import { cn } from '@/lib/cn';

/** NAV logomark: a two-facet navigation arrow, flat ink. */
export function LogoMark({ className, tile = false }: { className?: string; tile?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('nav-mark size-[22px] shrink-0 text-white', className)} aria-hidden="true">
      {tile && <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#070d19" stroke="rgb(196 214 232 / 0.22)" />}
      <path d="M16 4 27 27 16 21 5 27Z" fill="currentColor" />
      <path d="M16 4v17L5 27Z" fill="#02060f" opacity="0.3" />
    </svg>
  );
}

export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} aria-label="NAV">
      <LogoMark className={markClassName} />
      <span className="text-[16px] font-[531] tracking-[0.2em] text-fg" aria-hidden>
        NAV
      </span>
    </span>
  );
}
