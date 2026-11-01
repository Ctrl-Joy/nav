import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Table({ children, className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-[13px]', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border-strong text-left">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border-strong border-b border-border-strong">{children}</tbody>;
}

export function Tr({ className, interactive, ...rest }: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return <tr className={cn(interactive && 'cursor-pointer transition-colors hover:bg-surface-2', className)} {...rest} />;
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('h-11 px-3 font-mono text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-fg-muted uppercase first:pl-4', className)} {...rest} />;
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-[52px] px-3 align-middle first:pl-4', className)} {...rest} />;
}
