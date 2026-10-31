import { useMemo, useState, type FormEvent } from 'react';
import { Clock, Play, Terminal, X } from 'lucide-react';
import type { Run } from '@nav/shared';
import { useCancelRun, useCreateRun, useRunLogs, useRuns } from '@/api/services';
import { LogViewer } from '@/components/logs/LogViewer';
import { RelativeTime, useNow } from '@/components/RelativeTime';
import {
  Button,
  Card,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  StatusPill,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { describeCron } from '@/lib/cron';
import { durationBetween, formatDuration } from '@/lib/time';
import { useServiceCtx } from './context';

const isRunning = (r: Run) => r.status === 'pending' || r.status === 'running';

function RunLogsDialog({ run, onClose }: { run: Run | null; onClose: () => void }) {
  const logs = useRunLogs(run?.id ?? null, !!run && isRunning(run));
  return (
    <Dialog
      open={!!run}
      onClose={onClose}
      size="xl"
      title={run ? `${run.kind === 'cron' ? 'Cron run' : 'Job'} ${run.id.slice(-8)}` : ''}
      description={run ? <code className="font-mono text-xs">{run.command}</code> : undefined}
    >
      {run && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
            <StatusPill status={run.status} />
            <span>Exit code: <span className="font-mono text-fg">{run.exitCode ?? '—'}</span></span>
            <span>Duration: <span className="font-mono text-fg">{formatDuration(durationBetween(run.startedAt, run.finishedAt))}</span></span>
          </div>
          {logs.isError ? (
            <ErrorState error={logs.error} onRetry={() => logs.refetch()} />
          ) : (
            <LogViewer lines={logs.data?.items ?? []} loading={logs.isPending} height="h-[50vh]" label="Run logs" emptyText="No output recorded." />
          )}
        </div>
      )}
    </Dialog>
  );
}

export function ServiceJobsTab() {
  const { service } = useServiceCtx();
  const { canWrite } = useWorkspace();
  const toast = useToast();
  const runs = useRuns(service.id);
  const create = useCreateRun(service.id);
  const cancel = useCancelRun(service.id);
  const [selected, setSelected] = useState<Run | null>(null);
  const [jobOpen, setJobOpen] = useState(false);
  const [command, setCommand] = useState(service.startCommand ?? '');

  const list = useMemo(() => runs.data?.pages.flatMap((p) => p.items) ?? [], [runs.data]);
  useNow(1000, list.some(isRunning));
  const isCron = service.type === 'cron';
  const cron = isCron && service.cronSchedule ? describeCron(service.cronSchedule) : null;
  const liveSelected = selected ? (list.find((r) => r.id === selected.id) ?? selected) : null;

  const trigger = async () => {
    try {
      const r = await create.mutateAsync({});
      toast.success('Run triggered');
      setSelected(r);
    } catch (e) {
      toast.fromError(e, 'Could not trigger run');
    }
  };

  const submitJob = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await create.mutateAsync({ command: command.trim() });
      toast.success('Job started');
      setJobOpen(false);
      setSelected(r);
    } catch (err) {
      toast.fromError(err, 'Could not start job');
    }
  };

  return (
    <div className="space-y-5">
      {isCron && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <Clock className="size-4 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px] text-fg">{service.cronSchedule ?? 'No schedule'}</div>
            {cron && <div className="text-xs text-fg-muted">{cron.valid ? cron.description : cron.error}</div>}
          </div>
          {canWrite && (
            <Button variant="primary" size="sm" icon={<Play className="size-3.5" />} loading={create.isPending} onClick={trigger}>
              Trigger run
            </Button>
          )}
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold">{isCron ? 'Run history' : 'One-off jobs'}</h3>
          <p className="text-xs text-fg-subtle">Jobs run in a fresh instance using the latest successful build and this service’s environment.</p>
        </div>
        {canWrite && (
          <Button size="sm" icon={<Terminal className="size-3.5" />} onClick={() => setJobOpen(true)}>
            Run one-off job
          </Button>
        )}
      </div>
      {runs.isPending ? (
        <SkeletonRows rows={4} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : !list.length ? (
        <Empty compact icon={<Terminal className="size-5" />} title="No runs yet" description={isCron ? 'Runs appear here once the schedule fires.' : 'Run a one-off command such as a migration.'} />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Status</Th>
              <Th>Kind</Th>
              <Th>Command</Th>
              <Th>Trigger</Th>
              <Th>Exit</Th>
              <Th>Duration</Th>
              <Th>Started</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {list.map((r) => (
              <Tr key={r.id} interactive onClick={() => setSelected(r)}>
                <Td>
                  <StatusPill status={r.status} />
                </Td>
                <Td className="text-xs text-fg-muted capitalize">{r.kind}</Td>
                <Td className="max-w-72">
                  <button type="button" className="block max-w-full truncate text-left font-mono text-xs text-fg hover:text-accent" onClick={() => setSelected(r)}>
                    {r.command}
                  </button>
                </Td>
                <Td className="text-xs text-fg-muted">{r.trigger.replace(/_/g, ' ')}</Td>
                <Td className={r.exitCode ? 'font-mono text-xs text-danger' : 'font-mono text-xs text-fg-muted'}>{r.exitCode ?? '—'}</Td>
                <Td className="font-mono text-xs text-fg-muted">{r.startedAt ? formatDuration(durationBetween(r.startedAt, r.finishedAt)) : '—'}</Td>
                <Td className="text-xs text-fg-muted">
                  <RelativeTime value={r.startedAt ?? r.createdAt} />
                </Td>
                <Td className="text-right">
                  {canWrite && isRunning(r) && (
                    <Button
                      size="xs"
                      variant="outline-danger"
                      icon={<X className="size-3" />}
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await cancel.mutateAsync(r.id);
                          toast.success('Run canceled');
                        } catch (err) {
                          toast.fromError(err);
                        }
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {runs.hasNextPage && (
        <div className="flex justify-center">
          <Button size="sm" loading={runs.isFetchingNextPage} onClick={() => runs.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}

      <RunLogsDialog run={liveSelected} onClose={() => setSelected(null)} />
      <Dialog
        open={jobOpen}
        onClose={() => setJobOpen(false)}
        title="Run one-off job"
        description="Runs the command once in a new instance, then exits."
        footer={
          <>
            <Button onClick={() => setJobOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="one-off" loading={create.isPending} disabled={!command.trim()}>
              Run job
            </Button>
          </>
        }
      >
        <form id="one-off" onSubmit={submitJob}>
          <Field label="Command">{(id) => <Input id={id} mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run migrate" autoFocus />}</Field>
        </form>
      </Dialog>
    </div>
  );
}
