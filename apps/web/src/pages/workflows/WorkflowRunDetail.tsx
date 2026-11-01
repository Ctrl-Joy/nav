import { useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CornerDownRight } from 'lucide-react';
import type { WorkflowRun } from '@nav/shared';
import { isApiError } from '@/api/client';
import { isRunActive, useWorkflowRun, useWorkflowRunLogs } from '@/api/workflows';
import { LogViewer } from '@/components/logs/LogViewer';
import { RelativeTime, useNow } from '@/components/RelativeTime';
import { Card, CodeBlock, CopyButton, Empty, ErrorState, Skeleton, StatusPill, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { cn } from '@/lib/cn';
import { durationBetween, formatDateTime, formatDuration } from '@/lib/time';
import { useServiceCtx } from '../service/context';
import { RunActions, preview } from './WorkflowTabs';

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-fg-subtle uppercase">{label}</div>
      <div className="mt-0.5 truncate text-[13px] text-fg">{children}</div>
    </div>
  );
}

const pretty = (v: unknown) => (v === undefined ? 'null' : JSON.stringify(v, null, 2));

/** The whole run tree (root and every subtask), depth-first in creation order. */
function flattenTree(tree: WorkflowRun[]): WorkflowRun[] {
  const byParent = new Map<string | null, WorkflowRun[]>();
  for (const r of tree) {
    const key = r.parentRunId && tree.some((p) => p.id === r.parentRunId) ? r.parentRunId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), r]);
  }
  const out: WorkflowRun[] = [];
  const walk = (parent: string | null) => {
    for (const r of byParent.get(parent) ?? []) {
      out.push(r);
      walk(r.id);
    }
  };
  walk(null);
  return out;
}

export function WorkflowRunDetailTab() {
  const { runId = '' } = useParams();
  const { service } = useServiceCtx();
  const { ws } = useWorkspace();
  const detail = useWorkflowRun(runId);
  const run = detail.data?.run;
  const active = !!run && isRunActive(run.status);
  const logs = useWorkflowRunLogs(runId, active);
  useNow(1000, active);
  const tree = useMemo(() => flattenTree(detail.data?.tree ?? []), [detail.data]);
  const base = `/w/${ws}/services/${service.id}/runs`;

  if (detail.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (detail.isError || !run) {
    if (isApiError(detail.error) && detail.error.isNotFound) return <Empty title="Run not found" description="It may belong to another workflow, or the workflow was deleted." />;
    return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  }
  const minDepth = Math.min(...tree.map((r) => r.depth));

  return (
    <div className="space-y-5">
      <Link to={base} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3" /> All runs
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-[18px] text-fg">{run.task}</h2>
            <StatusPill status={run.status} />
          </div>
          <div className="mt-1 flex items-center gap-1 font-mono text-xs text-fg-subtle">
            {run.id}
            <CopyButton value={run.id} size="xs" label="Copy run id" />
          </div>
        </div>
        <RunActions workflowId={service.id} run={run} size="sm" />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
        <Stat label="Attempts">
          {run.attempts}/{run.maxAttempts}
        </Stat>
        <Stat label="Duration">{run.startedAt ? formatDuration(durationBetween(run.startedAt, run.finishedAt)) : '—'}</Stat>
        <Stat label="Created">
          <RelativeTime value={run.createdAt} />
        </Stat>
        <Stat label="Trigger">{run.trigger}</Stat>
        <Stat label="Timeout">{run.timeoutSeconds}s per execution</Stat>
        <Stat label="Parent">
          {run.parentRunId ? (
            <Link to={`${base}/${run.parentRunId}`} className="font-mono text-accent hover:underline">
              {run.parentRunId}
            </Link>
          ) : (
            '—'
          )}
        </Stat>
        <Stat label={run.status === 'queued' && run.nextAttemptAt ? 'Next attempt' : 'Wakes at'}>
          {run.status === 'queued' && run.nextAttemptAt ? formatDateTime(run.nextAttemptAt) : run.wakeAt ? formatDateTime(run.wakeAt) : '—'}
        </Stat>
        <Stat label="Idempotency key">{run.idempotencyKey ? <span className="font-mono">{run.idempotencyKey}</span> : '—'}</Stat>
      </Card>

      {run.error && (
        <div className="rounded-[3px] border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
          {run.status === 'queued' ? 'Last attempt failed: ' : ''}
          {run.error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBlock title="input" code={pretty(run.input)} wrap />
        <CodeBlock title={run.status === 'succeeded' ? 'output' : 'output (when it succeeds)'} code={run.status === 'succeeded' ? pretty(run.output) : '—'} wrap />
      </div>

      {tree.length > 1 && (
        <section>
          <h3 className="mb-2 text-[14px] font-semibold">Run tree</h3>
          <Table>
            <THead>
              <tr>
                <Th>Task</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Input</Th>
                <Th className="hidden md:table-cell">Output / error</Th>
                <Th>Attempts</Th>
                <Th>Duration</Th>
              </tr>
            </THead>
            <TBody>
              {tree.map((r) => (
                <Tr key={r.id} className={cn(r.id === run.id && 'bg-surface-2')}>
                  <Td>
                    <div className="flex items-center gap-1" style={{ paddingLeft: `${(r.depth - minDepth) * 18}px` }}>
                      {r.depth > minDepth && <CornerDownRight className="size-3 text-fg-subtle" aria-hidden />}
                      {r.id === run.id ? (
                        <span className="font-mono text-[13px] font-medium text-fg">{r.task}</span>
                      ) : (
                        <Link to={`${base}/${r.id}`} className="font-mono text-[13px] text-fg hover:text-accent">
                          {r.task}
                        </Link>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <StatusPill status={r.status} />
                  </Td>
                  <Td className="hidden max-w-48 truncate font-mono text-xs text-fg-muted md:table-cell">{preview(r.input, 40)}</Td>
                  <Td className={cn('hidden max-w-60 truncate font-mono text-xs md:table-cell', r.error && r.status !== 'succeeded' ? 'text-danger' : 'text-fg-muted')}>
                    {r.status === 'succeeded' ? preview(r.output, 50) : r.error ?? '—'}
                  </Td>
                  <Td className="text-xs text-fg-muted">
                    {r.attempts}/{r.maxAttempts}
                  </Td>
                  <Td className="font-mono text-xs text-fg-muted">{r.startedAt ? formatDuration(durationBetween(r.startedAt, r.finishedAt)) : '—'}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      {run.executions.length > 0 && (
        <section>
          <h3 className="mb-1 text-[14px] font-semibold">Executions</h3>
          <p className="mb-2 text-xs text-fg-subtle">Each attempt starts the task code; after subtasks or a sleep it is resumed and recorded steps are replayed.</p>
          <Table>
            <THead>
              <tr>
                <Th>Attempt</Th>
                <Th>Kind</Th>
                <Th>Outcome</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th className="hidden md:table-cell">Error</Th>
              </tr>
            </THead>
            <TBody>
              {run.executions.map((e, i) => (
                <Tr key={i}>
                  <Td className="text-xs text-fg-muted">{e.attempt}</Td>
                  <Td className="text-xs text-fg-muted">{e.kind}</Td>
                  <Td>{e.outcome ? <StatusPill status={e.outcome === 'timed_out' ? 'failed' : e.outcome === 'suspended' ? 'waiting' : e.outcome} label={e.outcome.replace('_', ' ')} /> : '—'}</Td>
                  <Td className="text-xs text-fg-muted">{formatDateTime(e.startedAt)}</Td>
                  <Td className="font-mono text-xs text-fg-muted">{formatDuration(durationBetween(e.startedAt, e.finishedAt))}</Td>
                  <Td className="hidden max-w-80 truncate text-xs text-danger md:table-cell">{e.error ?? ''}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[14px] font-semibold">Logs</h3>
        {logs.isError ? (
          <ErrorState error={logs.error} onRetry={() => logs.refetch()} />
        ) : (
          <LogViewer lines={logs.data?.items ?? []} loading={logs.isPending} height="h-[45vh]" label="Run logs" emptyText={active ? 'Waiting for output…' : 'No output recorded.'} />
        )}
      </section>
    </div>
  );
}
