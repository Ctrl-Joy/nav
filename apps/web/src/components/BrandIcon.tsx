import type { SimpleIcon } from 'simple-icons';

/** A technology logo from Simple Icons (CC0), drawn in the current text colour. */
export function BrandIcon({ icon, className }: { icon: SimpleIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={icon.path} />
    </svg>
  );
}
