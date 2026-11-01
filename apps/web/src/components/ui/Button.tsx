import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline-danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[3px] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 select-none';

const variants: Record<ButtonVariant, string> = {
  primary: 'nv-btn nv-cta',
  secondary: 'nv-btn nv-hair',
  ghost: 'font-medium text-fg-muted transition-colors hover:text-fg hover:bg-surface-2',
  danger: 'nv-btn border border-danger bg-danger font-medium text-white hover:brightness-110 dark:text-black',
  'outline-danger': 'font-medium border border-danger/50 text-danger transition-colors hover:bg-danger-soft',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs',
  sm: 'h-7 px-3 text-[13px]',
  md: 'h-8 px-3 text-[13px]',
  lg: 'h-10 px-5 text-[14px]',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-3.5 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export function IconButton({
  label,
  className,
  size = 'sm',
  variant = 'ghost',
  ...rest
}: Omit<ButtonProps, 'children'> & { label: string }) {
  const square = { xs: 'w-6 px-0', sm: 'w-7 px-0', md: 'w-8 px-0', lg: 'w-10 px-0' }[size];
  return <Button aria-label={label} title={label} variant={variant} size={size} className={cn(square, className)} {...rest} />;
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
