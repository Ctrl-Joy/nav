import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const controlClass =
  'w-full rounded-[3px] border border-border-strong bg-transparent px-2.5 text-[13px] text-fg placeholder:text-fg-subtle ' +
  'transition-colors hover:border-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  /** 38px tall variant (page-level search fields). */
  tall?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, mono, tall, leading, trailing, ...rest }, ref) {
  if (leading || trailing) {
    return (
      <div className={cn('relative flex items-center', className)}>
        {leading && <span className={cn('pointer-events-none absolute flex text-fg-subtle', tall ? 'left-3' : 'left-2.5')}>{leading}</span>}
        <input
          ref={ref}
          className={cn(controlClass, tall ? 'h-[38px] text-[14px]' : 'h-8', mono && 'font-mono text-[12.5px]', leading ? (tall ? 'pl-9' : 'pl-8') : '', trailing ? 'pr-9' : '')}
          {...rest}
        />
        {trailing && <span className="absolute right-1.5 flex">{trailing}</span>}
      </div>
    );
  }
  return <input ref={ref} className={cn(controlClass, tall ? 'h-[38px] text-[14px]' : 'h-8', mono && 'font-mono text-[12.5px]', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(controlClass, 'min-h-20 py-2 leading-relaxed', mono && 'font-mono text-[12.5px]', className)}
        spellCheck={mono ? false : undefined}
        {...rest}
      />
    );
  },
);

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  children: (id: string) => ReactNode;
}

/** Label + control + hint/error, wiring ids for accessibility. */
export function Field({ label, hint, error, optional, className, children }: FieldProps) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
          {optional && <span className="ml-1.5 font-normal text-fg-subtle">optional</span>}
        </label>
      )}
      {children(id)}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const sid = id ?? auto;
  const toggle = (
    <button
      id={sid}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-accent-strong bg-accent-strong' : 'border-border-strong bg-surface-3',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 rounded-full transition-transform',
          checked ? 'translate-x-[18px] bg-white' : 'translate-x-[2px] bg-fg-muted',
        )}
      />
    </button>
  );
  if (!label) return toggle;
  return (
    <div className="flex items-start gap-3">
      <div className="pt-0.5">{toggle}</div>
      <label htmlFor={sid} className="flex flex-col">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        {description && <span className="text-xs text-fg-subtle">{description}</span>}
      </label>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-[13px] text-fg', disabled && 'opacity-60')}>
      <input
        type="checkbox"
        className="size-4 rounded-[2px] border-border accent-[var(--accent-strong)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
