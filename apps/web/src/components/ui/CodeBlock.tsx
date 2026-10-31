import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { copyText } from '@/lib/misc';
import { cn } from '@/lib/cn';
import { IconButton } from './Button';
import { useToast } from './Toast';

export function CopyButton({ value, label = 'Copy', className, size = 'sm' }: { value: string; label?: string; className?: string; size?: 'xs' | 'sm' }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <IconButton
      label={label}
      size={size}
      className={className}
      icon={done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(value);
        if (ok) {
          setDone(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setDone(false), 1500);
        } else toast.error('Copy failed', 'Your browser blocked clipboard access.');
      }}
    />
  );
}

export function CodeBlock({ code, title, className, children, wrap }: { code: string; title?: ReactNode; className?: string; children?: ReactNode; wrap?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-[#0a0c0f] text-[#d6dde6]', className)}>
      {title !== undefined && (
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-xs text-[#8b95a3]">
          <span className="font-mono">{title}</span>
          <CopyButton value={code} size="xs" className="text-[#8b95a3] hover:bg-white/10 hover:text-white" />
        </div>
      )}
      <div className="relative">
        {title === undefined && (
          <CopyButton value={code} size="xs" className="absolute top-1.5 right-1.5 text-[#8b95a3] hover:bg-white/10 hover:text-white" />
        )}
        <pre className={cn('overflow-x-auto p-3 pr-10 font-mono text-[12.5px] leading-relaxed', wrap && 'break-all whitespace-pre-wrap')}>
          {children ?? code}
        </pre>
      </div>
    </div>
  );
}

/** Masked secret with reveal + copy. */
export function SecretValue({ value, className, mono = true }: { value: string; className?: string; mono?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className={cn('flex min-w-0 items-center gap-1 rounded-lg border border-border bg-bg-elevated pl-2.5', className)}>
      <span className={cn('min-w-0 flex-1 truncate py-1.5 text-[12.5px]', mono && 'font-mono')}>{shown ? value : '•'.repeat(Math.min(24, Math.max(8, value.length)))}</span>
      <IconButton
        label={shown ? 'Hide value' : 'Reveal value'}
        icon={shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        onClick={() => setShown((s) => !s)}
      />
      <CopyButton value={value} />
    </div>
  );
}

/** Inline value with copy button (non-secret). */
export function CopyField({ value, className, mono = true }: { value: string; className?: string; mono?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1 rounded-lg border border-border bg-bg-elevated pl-2.5', className)}>
      <span className={cn('min-w-0 flex-1 truncate py-1.5 text-[12.5px]', mono && 'font-mono')} title={value}>
        {value}
      </span>
      <CopyButton value={value} />
    </div>
  );
}
