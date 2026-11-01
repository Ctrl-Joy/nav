import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity as ActivityIcon, CheckCircle2, CircleDot, Rocket, RotateCcw, XCircle } from 'lucide-react';
import type { Event as NavEvent } from '@nav/shared';
import { useDatabases } from '@/api/databases';
import { useServices } from '@/api/services';
import { useWorkspaceEvents } from '@/api/workspaces';
import { RelativeTime } from '@/components/RelativeTime';
import { Button, Empty, ErrorState, PageHeader, Segmented, SkeletonRows } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { cn } from '@/lib/cn';
import { shortSha } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import { describeEvent } from './service/deployUtils';

type Filter = 'all' | 'deploys' | 'failures';

function eventText(e: NavEvent): string {
  const d = e.data ?? {};
  const sha = typeof d.commitSha === 'string' ? ` · ${shortSha(d.commitSha)}` : '';
  switch (e.kind) {
    case 'deploy_started':
    case 'deploy_queued':
      return `Deploy started${sha}`;
    case 'deploy_live':
      return `Deploy live${sha}`;
    case 'deploy_failed':
      return `Deploy failed${sha}${typeof d.error === 'string' ? ` — ${d.error}` : ''}`;
    case 'deploy_canceled':
      return `Deploy canceled${sha}`;
    case 'deploy_waiting_for_checks':
      return `Waiting for CI checks${sha}`;
    case 'deploy_skipped_checks_failed':
      return `Not deployed: CI checks failed${sha}`;
    default:
      return describeEvent(e);
  }
}

function eventIcon(kind: string) {
  if (kind === 'deploy_live') return <CheckCircle2 className="size-4 text-success" />;
  if (kind.endsWith('failed') || kind === 'instance_crashed') return <XCircle className="size-4 text-danger" />;
  if (kind.startsWith('deploy')) return <Rocket className="size-4 text-warning" />;
  if (kind === 'rollback') return <RotateCcw className="size-4 text-info" />;
  return <CircleDot className="size-4 text-fg-subtle" />;
}

export function ActivityPage() {
  useTitle('Activity');
  const { ws } = useWorkspace();
  const events = useWorkspaceEvents(ws);
  const services = useServices(ws);
  const databases = useDatabases(ws);
  const [filter, setFilter] = useState<Filter>('all');

  const names = useMemo(() => {
    const m = new Map<string, { name: string; href: string }>();
    for (const s of services.data?.items ?? []) m.set(s.id, { name: s.name, href: `/w/${ws}/services/${s.id}` });
    for (const d of databases.data?.items ?? []) m.set(d.id, { name: d.name, href: `/w/${ws}/databases/${d.id}` });
    return m;
  }, [services.data, databases.data, ws]);

  const items = useMemo(() => {
    const all = events.data?.pages.flatMap((p) => p.items) ?? [];
    if (filter === 'deploys') return all.filter((e) => e.kind.startsWith('deploy') || e.kind === 'rollback');
    if (filter === 'failures') return all.filter((e) => /fail|crash|error/.test(e.kind));
    return all;
  }, [events.data, filter]);

  return (
    <div>
      <PageHeader
        title="Activity"
        description="Everything that happened in this workspace, newest first."
        actions={
          <Segmented
            label="Filter events"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'deploys', label: 'Deploys' },
              { value: 'failures', label: 'Failures' },
            ]}
          />
        }
      />
      {events.isPending ? (
        <SkeletonRows rows={8} />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => events.refetch()} />
      ) : items.length === 0 ? (
        <Empty icon={<ActivityIcon className="size-4" />} title="No activity yet" description="Deploys, scaling, environment changes and more will show up here." />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ol className="divide-y divide-border">
            {items.map((e) => {
              const target = (e.serviceId && names.get(e.serviceId)) || (e.databaseId && names.get(e.databaseId)) || null;
              const deployId = typeof e.data?.deployId === 'string' ? e.data.deployId : null;
              return (
                <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5">{eventIcon(e.kind)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-fg">
                      {target ? (
                        <Link to={target.href} className="font-medium hover:text-accent">
                          {target.name}
                        </Link>
                      ) : null}
                      {target ? <span className="text-fg-subtle"> · </span> : null}
                      <span className={cn(/fail|crash/.test(e.kind) && 'text-danger')}>{eventText(e)}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      {e.actor ? `by ${e.actor.name}` : 'by NAV'}
                      {deployId && e.serviceId && (
                        <>
                          {' · '}
                          <Link to={`/w/${ws}/services/${e.serviceId}/deploys/${deployId}`} className="hover:text-accent">
                            view deploy
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                  <RelativeTime value={e.createdAt} className="shrink-0 text-xs text-fg-subtle" />
                </li>
              );
            })}
          </ol>
          {events.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" loading={events.isFetchingNextPage} onClick={() => events.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
