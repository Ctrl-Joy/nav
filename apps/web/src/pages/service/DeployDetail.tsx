import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, CircleDashed, GitCommit, Undo2, X } from 'lucide-react';
import type { Deploy, LogLine } from '@nav/shared';
import { api, buildUrl } from '@/api/client';
import { useCancelDeploy, useDeploy, useRollback } from '@/api/services';
import { CopyLogsButton } from '@/components/logs/CopyLogsButton';
import { LogViewer } from '@/components/logs/LogViewer';
import { useLogTail } from '@/components/logs/useLogTail';
import { RelativeTime, useNow } from '@/components/RelativeTime';
import { Button, Card, ErrorState, Skeleton, StatusPill, useConfirm, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { cn } from '@/lib/cn';
import { shortSha } from '@/lib/format';
import { durationBetween, formatDateTime, formatDuration } from '@/lib/time';
import { useServiceCtx } from './context';
import { isActive, triggerLabel } from './deployUtils';

type StepState = 'done' | 'active' | 'failed' | 'pending' | 'skipped';

function steps(d: Deploy): { label: string; state: StepState; duration: number | null }[] {
  const s = d.status;
  const order = ['queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress', 'live'];
  const failedAt: Record<string, number> = { build_failed: 1, pre_deploy_failed: 2, update_failed: 3 };
  let idx = order.indexOf(s);
  if (s === 'deactivated') idx = 4;
  const failed = failedAt[s];
  const canceled = s === 'canceled';
  const stateFor = (i: number): StepState => {
    if (failed !== undefined) return i < failed ? 'done' : i === failed ? 'failed' : 'pending';
    if (canceled) return i === 0 || (d.startedAt && i === 1) ? 'done' : 'pending';
    if (i < idx) return 'done';
    if (i === idx) return i === 4 ? 'done' : 'active';
    return 'pending';
  };
  const buildDur = d.startedAt ? durationBetween(d.startedAt, d.buildFinishedAt ?? (stateFor(1) === 'active' ? null : d.finishedAt)) : null;
  return [
    { label: 'Queued', state: stateFor(0), duration: durationBetween(d.createdAt, d.startedAt ?? (idx === 0 ? null : d.finishedAt)) },
    { label: d.trigger === 'rollback' ? 'Build (reused)' : 'Build', state: d.trigger === 'rollback' && stateFor(1) === 'done' ? 'skipped' : stateFor(1), duration: buildDur },
    { label: 'Pre-deploy', state: stateFor(2), duration: null },
    { label: 'Deploy', state: stateFor(3), duration: d.buildFinishedAt ? durationBetween(d.buildFinishedAt, d.finishedAt) : null },
    { label: 'Live', state: stateFor(4), duration: null },
  ];
}

export function DeployDetailTab() {
  const { deployId = '' } = useParams();
  const { service } = useServiceCtx();
  const { ws, canWrite } = useWorkspace();
  const q = useDeploy(deployId);
  const d = q.data;
  const cancel = useCancelDeploy(service.id);
  const rollback = useRollback(service.id);
  const confirm = useConfirm();
  const toast = useToast();
  useNow(1000, !!d && isActive(d));

  const fetchPage = useCallback(() => api.get<{ items: LogLine[] }>(`/deploys/${deployId}/logs`), [deployId]);
  const streamUrl = useCallback((after: number | undefined) => buildUrl(`/deploys/${deployId}/logs/stream`, { after }), [deployId]);
  const tail = useLogTail({
    key: deployId ? `deploy:${deployId}` : null,
    fetchPage,
    streamUrl: d && !isActive(d) ? null : streamUrl,
    supportsOlder: false,
    endEvents: ['end'],
    pageSize: 5000,
  });

  if (q.isPending) return <Skeleton className="h-96 w-full" />;
  if (q.isError || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const current = d.id === service.currentDeployId;
  const total = durationBetween(d.startedAt ?? d.createdAt, d.finishedAt);

  return (
    <div className="space-y-5">
      <Link to={`/w/${ws}/services/${service.id}`} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> All events
      </Link>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold">Deploy {shortSha(d.commitSha) || d.id.slice(-8)}</h2>
              <StatusPill status={d.status} />
              {current && <span className="rounded bg-success-soft px-1.5 text-[11px] font-medium text-success">Current</span>}
            </div>
            {d.commitMessage && (
              <p className="mt-1 flex items-start gap-1.5 text-[13px] text-fg-muted">
                <GitCommit className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{d.commitMessage}</span>
              </p>
            )}
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-subtle">
              <div>
                <dt className="inline">Trigger: </dt>
                <dd className="inline text-fg-muted">{triggerLabel(d.trigger)}</dd>
              </div>
              {d.branch && (
                <div>
                  <dt className="inline">Branch: </dt>
                  <dd className="inline font-mono text-fg-muted">{d.branch}</dd>
                </div>
              )}
              {d.commitAuthor && (
                <div>
                  <dt className="inline">Author: </dt>
                  <dd className="inline text-fg-muted">{d.commitAuthor}</dd>
                </div>
              )}
              <div>
                <dt className="inline">Started: </dt>
                <dd className="inline text-fg-muted" title={formatDateTime(d.createdAt)}>
                  <RelativeTime value={d.createdAt} />
                </dd>
              </div>
              <div>
                <dt className="inline">{isActive(d) ? 'Elapsed' : 'Total'}: </dt>
                <dd className="inline font-mono text-fg-muted">{formatDuration(total)}</dd>
              </div>
              {d.rollbackOf && (
                <div>
                  <dt className="inline">Rollback of: </dt>
                  <dd className="inline">
                    <Link className="font-mono text-accent hover:underline" to={`/w/${ws}/services/${service.id}/deploys/${d.rollbackOf}`}>
                      {d.rollbackOf.slice(-8)}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          </div>
          {canWrite && (
            <div className="flex gap-2">
              {isActive(d) && (
                <Button
                  variant="outline-danger"
                  size="sm"
                  icon={<X className="size-3.5" />}
                  loading={cancel.isPending}
                  onClick={async () => {
                    try {
                      await cancel.mutateAsync(d.id);
                      toast.success('Deploy canceled');
                    } catch (e) {
                      toast.fromError(e);
                    }
                  }}
                >
                  Cancel deploy
                </Button>
              )}
              {!current && (d.status === 'live' || d.status === 'deactivated') && (
                <Button
                  size="sm"
                  icon={<Undo2 className="size-3.5" />}
                  onClick={async () => {
                    if (!(await confirm({ title: 'Roll back to this deploy?', body: 'Its build artifact is redeployed without rebuilding.', confirmText: 'Roll back' }))) return;
                    try {
                      await rollback.mutateAsync(d.id);
                      toast.success('Rollback started');
                    } catch (e) {
                      toast.fromError(e);
                    }
                  }}
                >
                  Rollback
                </Button>
              )}
            </div>
          )}
        </div>

        <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Deploy progress">
          {steps(d).map((s) => (
            <li
              key={s.label}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs',
                s.state === 'done' && 'border-success/30 bg-success-soft text-fg',
                s.state === 'skipped' && 'border-border text-fg-subtle',
                s.state === 'active' && 'border-warning/40 bg-warning-soft text-fg',
                s.state === 'failed' && 'border-danger/40 bg-danger-soft text-fg',
                s.state === 'pending' && 'border-border text-fg-subtle',
              )}
            >
              {s.state === 'done' || s.state === 'skipped' ? (
                <Check className="size-3.5 text-success" />
              ) : s.state === 'failed' ? (
                <X className="size-3.5 text-danger" />
              ) : (
                <CircleDashed className={cn('size-3.5', s.state === 'active' && 'animate-spin text-warning')} />
              )}
              <span className="flex-1 font-medium">{s.label}</span>
              {s.duration != null && s.state !== 'pending' && <span className="font-mono text-fg-muted">{formatDuration(s.duration)}</span>}
            </li>
          ))}
        </ol>
        {d.error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 font-mono text-xs break-words text-danger">{d.error}</p>}
      </Card>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg-muted">Build & deploy logs</h3>
          <CopyLogsButton lines={tail.lines} />
        </div>
        {tail.error && <p className="mb-2 text-xs text-danger">{tail.error}</p>}
        <LogViewer
          lines={tail.lines}
          loading={tail.loading}
          state={isActive(d) ? tail.state : undefined}
          showStream
          label="Deploy logs"
          emptyText={isActive(d) ? 'Waiting for the build to start…' : 'No logs were recorded for this deploy.'}
        />
      </div>
    </div>
  );
}
