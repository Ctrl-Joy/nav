import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Activity, GitCommit, History, Rocket, Undo2, X } from 'lucide-react';
import type { Deploy, Event as NavEvent } from '@nav/shared';
import { useCancelDeploy, useDeploys, useRollback, useServiceEvents } from '@/api/services';
import { RelativeTime, useNow } from '@/components/RelativeTime';
import { Button, Empty, ErrorState, SkeletonRows, StatusPill, useConfirm, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { shortSha } from '@/lib/format';
import { useServiceCtx } from './context';
import { DEPLOY_EVENT_KINDS, deployTiming, describeEvent, isActive, triggerLabel } from './deployUtils';

type Item = { kind: 'deploy'; at: string; deploy: Deploy } | { kind: 'event'; at: string; event: NavEvent };

export function ServiceEventsTab() {
  const { service } = useServiceCtx();
  const { ws, canWrite } = useWorkspace();
  const deploys = useDeploys(service.id);
  const events = useServiceEvents(service.id);
  const cancel = useCancelDeploy(service.id);
  const rollback = useRollback(service.id);
  const confirm = useConfirm();
  const toast = useToast();

  const deployList = useMemo(() => deploys.data?.pages.flatMap((p) => p.items) ?? [], [deploys.data]);
  const anyActive = deployList.some(isActive);
  useNow(1000, anyActive);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = deployList.map((d) => ({ kind: 'deploy', at: d.createdAt, deploy: d }));
    for (const e of events.data?.pages.flatMap((p) => p.items) ?? []) {
      if (DEPLOY_EVENT_KINDS.has(e.kind)) continue;
      out.push({ kind: 'event', at: e.createdAt, event: e });
    }
    return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [deployList, events.data]);

  const onCancel = async (d: Deploy) => {
    if (!(await confirm({ title: 'Cancel this deploy?', body: 'The current live deploy keeps serving traffic.', confirmText: 'Cancel deploy', danger: true }))) return;
    try {
      await cancel.mutateAsync(d.id);
      toast.success('Deploy canceled');
    } catch (e) {
      toast.fromError(e, 'Could not cancel deploy');
    }
  };

  const onRollback = async (d: Deploy) => {
    const ok = await confirm({
      title: `Roll back to ${shortSha(d.commitSha) || 'this deploy'}?`,
      body: (
        <>
          NAV redeploys this deploy’s build artifact without rebuilding. Environment variables currently set are used. Auto-deploy settings are left unchanged —
          a new push may deploy over this rollback.
        </>
      ),
      confirmText: 'Roll back',
    });
    if (!ok) return;
    try {
      await rollback.mutateAsync(d.id);
      toast.success('Rollback started');
    } catch (e) {
      toast.fromError(e, 'Rollback failed');
    }
  };

  if (deploys.isPending) return <SkeletonRows rows={6} />;
  if (deploys.isError) return <ErrorState error={deploys.error} onRetry={() => deploys.refetch()} />;
  if (!items.length) {
    return <Empty icon={<Rocket className="size-5" />} title="No deploys yet" description="Push to your branch or trigger a manual deploy to get this service live." />;
  }

  return (
    <div>
      <ol className="relative space-y-0 overflow-hidden rounded-lg border border-border bg-surface">
        {items.map((it) => {
          if (it.kind === 'event') {
            const e = it.event;
            return (
              <li key={`e-${e.id}`} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-subtle">
                  <Activity className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1 text-[13px]">
                  <span className="text-fg">{describeEvent(e)}</span>
                  {e.actor && <span className="text-fg-subtle"> · by {e.actor.name}</span>}
                </div>
                <RelativeTime value={e.createdAt} className="shrink-0 text-xs text-fg-subtle" />
              </li>
            );
          }
          const d = it.deploy;
          const current = d.id === service.currentDeployId;
          const canRollback = canWrite && !current && (d.status === 'live' || d.status === 'deactivated');
          return (
            <li key={`d-${d.id}`} className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2/40">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                {d.trigger === 'rollback' ? <History className="size-3.5" /> : <Rocket className="size-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/w/${ws}/services/${service.id}/deploys/${d.id}`} className="text-[13px] font-medium text-fg hover:text-accent hover:underline">
                    Deploy {d.status === 'live' ? 'live' : d.status.endsWith('failed') ? 'failed' : isActive(d) ? 'in progress' : d.status.replace(/_/g, ' ')}
                  </Link>
                  <StatusPill status={d.status} />
                  {current && <span className="rounded bg-success-soft px-1.5 text-[11px] font-medium text-success">Current</span>}
                  {d.clearCache && <span className="text-[11px] text-fg-subtle">cache cleared</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
                  {d.commitSha && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <GitCommit className="size-3 shrink-0" />
                      <code className="font-mono text-fg">{shortSha(d.commitSha)}</code>
                      {d.commitMessage && <span className="max-w-[28rem] truncate">{d.commitMessage.split('\n')[0]}</span>}
                    </span>
                  )}
                  <span className="text-fg-subtle">
                    {triggerLabel(d.trigger)}
                    {d.commitAuthor ? ` · ${d.commitAuthor}` : ''}
                  </span>
                  <span className="text-fg-subtle">{deployTiming(d)}</span>
                </div>
                {d.error && <p className="mt-1 truncate text-xs text-danger">{d.error}</p>}
              </div>
              <div className="flex items-center gap-2">
                <RelativeTime value={d.createdAt} className="text-xs text-fg-subtle" />
                {canWrite && isActive(d) && (
                  <Button size="xs" variant="outline-danger" icon={<X className="size-3" />} onClick={() => onCancel(d)}>
                    Cancel
                  </Button>
                )}
                {canRollback && (
                  <Button size="xs" icon={<Undo2 className="size-3" />} onClick={() => onRollback(d)}>
                    Rollback
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {(deploys.hasNextPage || events.hasNextPage) && (
        <div className="mt-4 flex justify-center">
          <Button
            size="sm"
            loading={deploys.isFetchingNextPage || events.isFetchingNextPage}
            onClick={() => {
              if (deploys.hasNextPage) void deploys.fetchNextPage();
              if (events.hasNextPage) void events.fetchNextPage();
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
