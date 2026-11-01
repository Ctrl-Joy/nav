import { Boxes, Clock, Cog, Database, DatabaseZap, FileStack, Globe, Layers, Lock, Workflow, type LucideIcon } from 'lucide-react';
import type { ServiceType } from '@nav/shared';
import { cn } from '@/lib/cn';

export type ResourceKind = ServiceType | 'postgres' | 'keyvalue' | 'blueprint' | 'env_group';

export const RESOURCE_META: Record<ResourceKind, { label: string; icon: LucideIcon; description: string }> = {
  web: { label: 'Web Service', icon: Globe, description: 'Public HTTP app with a URL, TLS and zero-downtime deploys.' },
  private: { label: 'Private Service', icon: Lock, description: 'Reachable only from your workspace private network.' },
  worker: { label: 'Background Worker', icon: Cog, description: 'Long-running process for queues and async jobs.' },
  cron: { label: 'Cron Job', icon: Clock, description: 'Run a command on a schedule.' },
  static: { label: 'Static Site', icon: Layers, description: 'Build once, serve from the edge with custom headers & rewrites.' },
  workflow: { label: 'Workflow', icon: Workflow, description: 'Durable background tasks with retries, timeouts and subtasks.' },
  postgres: { label: 'Postgres', icon: Database, description: 'Managed PostgreSQL with backups and a query console.' },
  keyvalue: { label: 'Key Value', icon: DatabaseZap, description: 'Managed Redis-compatible store for caches, queues and sessions.' },
  blueprint: { label: 'Blueprint', icon: FileStack, description: 'Infrastructure as code from a nav.yaml file.' },
  env_group: { label: 'Env Group', icon: Boxes, description: 'Shared environment variables.' },
};

export function ResourceIcon({ kind, className, boxed = true }: { kind: ResourceKind; className?: string; boxed?: boolean }) {
  const Icon = RESOURCE_META[kind]?.icon ?? Globe;
  if (!boxed) return <Icon className={cn('size-4 text-fg-muted', className)} aria-hidden />;
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-fg-muted', className)}>
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}
