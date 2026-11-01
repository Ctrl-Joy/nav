import { Link, Outlet, useParams } from 'react-router-dom';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useKeyValue, useKeyValueAction } from '@/api/keyvalue';
import { ResourceIcon } from '@/components/ResourceIcon';
import { Button, Empty, ErrorState, RouteTabs, Skeleton, StatusPill, useConfirm, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';
import { kvPlanName, type KeyValueOutletCtx } from './context';

export function KeyValueLayout() {
  const { keyValueId = '' } = useParams();
  const { ws, canWrite } = useWorkspace();
  const kv = useKeyValue(keyValueId);
  const action = useKeyValueAction({ id: keyValueId, workspaceId: ws });
  const confirm = useConfirm();
  const toast = useToast();
  useTitle(kv.data?.name ?? 'Key Value');

  if (kv.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (kv.isError) {
    if (isApiError(kv.error) && kv.error.isNotFound) {
      return (
        <Empty
          title="Key Value not found"
          description="It may have been deleted."
          action={
            <Link to={`/w/${ws}/key-value`} className="text-[13px] font-medium text-accent hover:underline">
              Back to Key Value
            </Link>
          }
        />
      );
    }
    return <ErrorState error={kv.error} onRetry={() => kv.refetch()} />;
  }

  const k = kv.data;
  const run = async (a: 'suspend' | 'resume') => {
    if (a === 'suspend') {
      const ok = await confirm({
        title: `Suspend ${k.name}?`,
        body: 'The instance stops and refuses connections until resumed.',
        confirmText: 'Suspend',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await action.mutateAsync(a);
      toast.success(a === 'suspend' ? 'Key Value suspending' : 'Key Value resuming');
    } catch (e) {
      toast.fromError(e, `Could not ${a} Key Value`);
    }
  };

  const base = `/w/${ws}/key-value/${k.id}`;
  const ctx: KeyValueOutletCtx = { keyValue: k };

  return (
    <div>
      <Link to={`/w/${ws}/key-value`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Key Value
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ResourceIcon kind="keyvalue" className="size-10" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[24px] leading-tight font-normal tracking-[-0.02em] md:text-[28px]">{k.name}</h1>
              <StatusPill status={k.status} />
            </div>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              Key Value · {kvPlanName(k.plan)} · <span className="font-mono text-xs">{k.maxmemoryPolicy}</span>
            </p>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {k.status === 'suspended' ? (
              <Button size="sm" icon={<Play className="size-3.5" />} loading={action.isPending} onClick={() => run('resume')}>
                Resume
              </Button>
            ) : (
              <Button size="sm" icon={<Pause className="size-3.5" />} disabled={k.status !== 'available' || action.isPending} onClick={() => run('suspend')}>
                Suspend
              </Button>
            )}
          </div>
        )}
      </div>
      <RouteTabs
        className="mb-6"
        label="Key Value sections"
        items={[
          { to: base, label: 'Info', end: true },
          { to: `${base}/logs`, label: 'Logs' },
          { to: `${base}/settings`, label: 'Settings' },
        ]}
      />
      <Outlet context={ctx} />
    </div>
  );
}
