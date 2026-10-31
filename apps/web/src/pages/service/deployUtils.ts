import type { Deploy, DeployTrigger, Event as NavEvent } from '@nav/shared';
import { DEPLOY_ACTIVE } from '@nav/shared';
import { durationBetween, formatDuration } from '@/lib/time';

export const TRIGGER_LABEL: Record<DeployTrigger, string> = {
  new_service: 'New service',
  git_push: 'Git push',
  manual: 'Manual deploy',
  api: 'API',
  rollback: 'Rollback',
  deploy_hook: 'Deploy hook',
  env_change: 'Environment updated',
  blueprint: 'Blueprint sync',
  preview: 'Preview',
  config_change: 'Config change',
};

export function triggerLabel(t: string): string {
  return TRIGGER_LABEL[t as DeployTrigger] ?? t.replace(/_/g, ' ');
}

export function isActive(d: Deploy): boolean {
  return DEPLOY_ACTIVE.includes(d.status);
}

/** "Built in 42s" / "Live in 1m 02s" / "Running for 12s" */
export function deployTiming(d: Deploy): string {
  if (isActive(d)) {
    const ms = durationBetween(d.startedAt ?? d.createdAt, null);
    return d.status === 'queued' ? 'Queued' : `Running for ${formatDuration(ms)}`;
  }
  const total = durationBetween(d.startedAt ?? d.createdAt, d.finishedAt);
  const build = d.buildFinishedAt ? durationBetween(d.startedAt, d.buildFinishedAt) : null;
  if (d.status === 'live' || d.status === 'deactivated') {
    return build != null ? `Built in ${formatDuration(build)} · live in ${formatDuration(total)}` : `Live in ${formatDuration(total)}`;
  }
  return `Took ${formatDuration(total)}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}

/** Human-readable sentence for a non-deploy event. */
export function describeEvent(e: NavEvent): string {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'service_created':
      return 'Service created';
    case 'scaled': {
      const from = str(d.from) ?? str(d.previous);
      const to = str(d.to) ?? str(d.instanceCount);
      return to ? `Scaled ${from ? `from ${from} ` : ''}to ${to} instance${to === '1' ? '' : 's'}` : 'Scaled';
    }
    case 'autoscaled':
      return `Autoscaled to ${str(d.to) ?? str(d.instanceCount) ?? '?'} instances`;
    case 'env_updated':
      return 'Environment variables updated';
    case 'secret_files_updated':
      return 'Secret files updated';
    case 'domain_added':
      return `Custom domain ${str(d.domain) ?? ''} added`;
    case 'domain_removed':
      return `Custom domain ${str(d.domain) ?? ''} removed`;
    case 'domain_verified':
      return `Custom domain ${str(d.domain) ?? ''} verified`;
    case 'certificate_issued':
      return `TLS certificate issued for ${str(d.domain) ?? 'domain'}`;
    case 'suspended':
      return 'Service suspended';
    case 'resumed':
      return 'Service resumed';
    case 'restarted':
      return 'Service restarted';
    case 'rollback':
      return 'Rollback started';
    case 'plan_changed':
      return `Instance type changed to ${str(d.plan) ?? str(d.to) ?? '?'}`;
    case 'settings_updated':
    case 'service_updated':
      return 'Settings updated';
    case 'instance_crashed':
      return `Instance crashed${str(d.exitCode) ? ` (exit code ${str(d.exitCode)})` : ''}`;
    case 'maintenance_on':
      return 'Maintenance mode enabled';
    case 'maintenance_off':
      return 'Maintenance mode disabled';
    default: {
      const msg = str(d.message);
      const label = e.kind.replace(/_/g, ' ');
      return msg ? `${label[0]?.toUpperCase()}${label.slice(1)}: ${msg}` : `${label[0]?.toUpperCase()}${label.slice(1)}`;
    }
  }
}

export const DEPLOY_EVENT_KINDS = new Set(['deploy_started', 'deploy_live', 'deploy_failed', 'deploy_canceled', 'deploy_queued', 'build_started', 'build_finished']);
