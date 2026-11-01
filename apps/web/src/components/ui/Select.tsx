import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { controlClass } from './Input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'size'> {
  options: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
}

/** Native select (fully keyboard/AT accessible) with NAV styling. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className, size = 'md', ...rest },
  ref,
) {
  return (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        className={cn(controlClass, 'appearance-none pr-8', size === 'sm' ? 'h-7 text-xs' : 'h-8')}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
    </div>
  );
});

/** Pill-style segmented control (single choice). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'sm',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  size?: 'xs' | 'sm';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            '-ml-px border font-medium transition-colors first:ml-0 first:rounded-l-[3px] last:rounded-r-[3px]',
            size === 'xs' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
            value === o.value ? 'relative z-10 border-accent-strong bg-nav-active text-nav-active-fg' : 'border-border-strong text-fg hover:bg-surface-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
