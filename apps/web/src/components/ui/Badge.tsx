import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

const toneClass: Record<Tone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  neutral: 'bg-neutral-soft text-fg-muted',
  accent: 'bg-accent-soft text-accent',
};

const dotClass: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
  accent: 'bg-accent',
};

export function Badge({ tone = 'neutral', children, className, mono }: { tone?: Tone; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium whitespace-nowrap',
        mono && 'font-mono',
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

interface StatusDef {
  tone: Tone;
  label: string;
  pulse?: boolean;
}

/** Every status string used across the API mapped to a tone + label. */
const STATUS: Record<string, StatusDef> = {
  // service
  created: { tone: 'neutral', label: 'Created' },
  deploying: { tone: 'warning', label: 'Deploying', pulse: true },
  live: { tone: 'success', label: 'Live' },
  failed: { tone: 'danger', label: 'Failed' },
  suspended: { tone: 'neutral', label: 'Suspended' },
  sleeping: { tone: 'info', label: 'Sleeping' },
  // deploy
  queued: { tone: 'neutral', label: 'Queued', pulse: true },
  build_in_progress: { tone: 'warning', label: 'Building', pulse: true },
  pre_deploy_in_progress: { tone: 'warning', label: 'Pre-deploy', pulse: true },
  update_in_progress: { tone: 'info', label: 'Deploying', pulse: true },
  deactivated: { tone: 'neutral', label: 'Deactivated' },
  build_failed: { tone: 'danger', label: 'Build failed' },
  pre_deploy_failed: { tone: 'danger', label: 'Pre-deploy failed' },
  update_failed: { tone: 'danger', label: 'Deploy failed' },
  canceled: { tone: 'neutral', label: 'Canceled' },
  // database
  creating: { tone: 'warning', label: 'Creating', pulse: true },
  available: { tone: 'success', label: 'Available' },
  deleting: { tone: 'danger', label: 'Deleting', pulse: true },
  restoring: { tone: 'info', label: 'Restoring', pulse: true },
  // instance
  starting: { tone: 'warning', label: 'Starting', pulse: true },
  healthy: { tone: 'success', label: 'Healthy' },
  unhealthy: { tone: 'danger', label: 'Unhealthy' },
  draining: { tone: 'info', label: 'Draining', pulse: true },
  stopped: { tone: 'neutral', label: 'Stopped' },
  crashed: { tone: 'danger', label: 'Crashed' },
  // run / backup
  pending: { tone: 'neutral', label: 'Pending', pulse: true },
  running: { tone: 'info', label: 'Running', pulse: true },
  succeeded: { tone: 'success', label: 'Succeeded' },
  completed: { tone: 'success', label: 'Completed' },
  // domains / certs
  unverified: { tone: 'warning', label: 'Unverified' },
  verified: { tone: 'success', label: 'Verified' },
  issuing: { tone: 'info', label: 'Issuing', pulse: true },
  issued: { tone: 'success', label: 'Certificate issued' },
  // blueprint
  syncing: { tone: 'info', label: 'Syncing', pulse: true },
  in_sync: { tone: 'success', label: 'In sync' },
  error: { tone: 'danger', label: 'Error' },
};

export function statusDef(status: string): StatusDef {
  return STATUS[status] ?? { tone: 'neutral', label: status.replace(/_/g, ' ') };
}

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', dotClass[tone], pulse && 'animate-pulse-dot', className)} />;
}

export function StatusPill({ status, label, className }: { status: string; label?: string; className?: string }) {
  const def = statusDef(status);
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap', toneClass[def.tone], className)}
    >
      <StatusDot tone={def.tone} pulse={def.pulse} />
      {label ?? def.label}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-[10.5px] text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
