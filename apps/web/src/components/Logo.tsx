import { cn } from '@/lib/cn';

/** Brand violet used by the slash in the mark. */
export const NAV_VIOLET = '#6b4ef6';

/**
 * NAV logomark: a rounded chevron (the "A") with a notched right leg, and a violet slash completing the "N".
 * The chevron follows `currentColor`, so it reads white on dark surfaces and ink on light ones.
 * Round stroke joins on top of the fills soften every corner the way the brand artwork does.
 */
export function LogoMark({ className, tile = false }: { className?: string; tile?: boolean }) {
  return (
    // cn() doesn't resolve Tailwind conflicts, so the default height only applies when the caller sets none.
    <svg viewBox="-12 -12 400 238" className={cn('nav-mark w-auto shrink-0 text-white', !/(^|\s)h-/.test(className ?? '') && 'h-[22px]', className)} aria-hidden="true">
      {tile && <rect x="-12" y="-12" width="400" height="238" rx="40" fill="#08080c" />}
      <path
        d="M7 213 97 43h88l87 142h-84l-45-70-54 98Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinejoin="round"
      />
      <path d="M310 7h53l-76 144-44-33Z" fill={NAV_VIOLET} stroke={NAV_VIOLET} strokeWidth="14" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark plus the lowercase "nav" wordmark. */
export function Logo({ className, markClassName, wordClassName }: { className?: string; markClassName?: string; wordClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-[0.4em] text-fg', className)} aria-label="NAV">
      <LogoMark className={cn('h-[1.12em]', markClassName)} />
      <span
        className={cn('font-semibold leading-none tracking-[-0.035em]', wordClassName)}
        style={{ fontFamily: "'Inter Variable', Inter, system-ui, sans-serif" }}
        aria-hidden
      >
        nav
      </span>
    </span>
  );
}
