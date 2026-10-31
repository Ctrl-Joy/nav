import { Link, Outlet, useParams } from 'react-router-dom';
import { ArrowLeft, Pause, Play, RotateCw } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useDatabase, useDatabaseAction } from '@/api/databases';
import { ResourceIcon } from '@/components/ResourceIcon';
import { Button, Empty, ErrorState, RouteTabs, Skeleton, StatusPill, useConfirm, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';
import type { DatabaseOutletCtx } from './context';
import { planName } from './DatabasesList';

export function DatabaseLayout() {
  const { databaseId = '' } = useParams();
  const { ws, canWrite } = useWorkspace();
  const db = useDatabase(databaseId);
  const action = useDatabaseAction({ id: databaseId, workspaceId: ws });
  const confirm = useConfirm();
  const toast = useToast();
  useTitle(db.data?.name ?? 'Postgres');

  if (db.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (db.isError) {
    if (isApiError(db.error) && db.error.isNotFound) {
      return (
        <Empty
          title="Database not found"
          description="It may have been deleted."
          action={
            <Link to={`/w/${ws}/databases`} className="text-[13px] font-medium text-accent hover:underline">
              Back to Postgres
            </Link>
          }
        />
      );
    }
    return <ErrorState error={db.error} onRetry={() => db.refetch()} />;
  }

  const d = db.data;
  const run = async (a: 'suspend' | 'resume' | 'restart') => {
    if (a !== 'resume') {
      const ok = await confirm({
        title: a === 'suspend' ? `Suspend ${d.name}?` : `Restart ${d.name}?`,
        body:
          a === 'suspend'
            ? 'The database will stop and refuse connections until resumed. Data is kept.'
            : 'Open connections will be dropped while PostgreSQL restarts.',
        confirmText: a === 'suspend' ? 'Suspend' : 'Restart',
        danger: a === 'suspend',
      });
      if (!ok) return;
    }
    try {
      await action.mutateAsync(a);
      toast.success(a === 'suspend' ? 'Database suspended' : a === 'resume' ? 'Database resuming' : 'Database restarting');
    } catch (e) {
      toast.fromError(e, `Could not ${a} database`);
    }
  };

  const base = `/w/${ws}/databases/${d.id}`;
  const ctx: DatabaseOutletCtx = { database: d };

  return (
    <div>
      <Link to={`/w/${ws}/databases`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Postgres
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ResourceIcon kind="postgres" className="size-10" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{d.name}</h1>
              <StatusPill status={d.status} />
            </div>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              PostgreSQL {d.pgVersion} · {planName(d.plan)} · {d.diskGB} GB disk
            </p>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<RotateCw className="size-3.5" />}
              disabled={d.status !== 'available' || action.isPending}
              onClick={() => run('restart')}
            >
              Restart
            </Button>
            {d.status === 'suspended' ? (
              <Button size="sm" icon={<Play className="size-3.5" />} loading={action.isPending} onClick={() => run('resume')}>
                Resume
              </Button>
            ) : (
              <Button size="sm" icon={<Pause className="size-3.5" />} disabled={d.status !== 'available' || action.isPending} onClick={() => run('suspend')}>
                Suspend
              </Button>
            )}
          </div>
        )}
      </div>
      <RouteTabs
        className="mb-6"
        label="Database sections"
        items={[
          { to: base, label: 'Info', end: true },
          { to: `${base}/logs`, label: 'Logs' },
          { to: `${base}/metrics`, label: 'Metrics' },
          { to: `${base}/backups`, label: 'Backups' },
          { to: `${base}/access`, label: 'Access control' },
          { to: `${base}/query`, label: 'Query' },
          { to: `${base}/settings`, label: 'Settings' },
        ]}
      />
      <Outlet context={ctx} />
    </div>
  );
}
