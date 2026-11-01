import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ListTree, Play, RotateCcw, Search, X } from 'lucide-react';
import type { WorkflowRun, WorkflowRunStatus, WorkflowTask } from '@nav/shared';
import { isRunActive, useCancelWorkflowRun, useRetryWorkflowRun, useStartWorkflowRun, useUpdateWorkflow, useWorkflow, useWorkflowRuns } from '@/api/workflows';
import { RelativeTime, useNow } from '@/components/RelativeTime';
import {
  Button,
  Card,
  Checkbox,
  CodeBlock,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Input,
  Select,
  SettingRow,
  SkeletonRows,
  StatusPill,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { durationBetween, formatDuration } from '@/lib/time';
import { useServiceCtx } from '../service/context';

const STATUS_FILTERS: { value: string; label: string; statuses?: WorkflowRunStatus[] }[] = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active', statuses: ['queued', 'running', 'waiting'] },
  { value: 'queued', label: 'Queued', statuses: ['queued'] },
  { value: 'running', label: 'Running', statuses: ['running'] },
  { value: 'waiting', label: 'Waiting', statuses: ['waiting'] },
  { value: 'succeeded', label: 'Succeeded', statuses: ['succeeded'] },
  { value: 'failed', label: 'Failed', statuses: ['failed'] },
  { value: 'canceled', label: 'Canceled', statuses: ['canceled'] },
];

export const preview = (value: unknown, max = 80): string => {
  if (value === null || value === undefined) return '—';
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Starts a run of one of the workflow's tasks with a JSON input. */
export function RunTaskDialog({ workflowId, tasks, initialTask, open, onClose }: { workflowId: string; tasks: WorkflowTask[]; initialTask?: string; open: boolean; onClose: () => void }) {
  const [task, setTask] = useState(initialTask ?? tasks[0]?.name ?? '');
  const [input, setInput] = useState('{\n  \n}');
  const [key, setKey] = useState('');
  const start = useStartWorkflowRun(workflowId);
  const navigate = useNavigate();
  const { ws } = useWorkspace();
  const toast = useToast();
  const parsed = useMemo(() => {
    if (!input.trim()) return { ok: true as const, value: null };
    try {
      return { ok: true as const, value: JSON.parse(input) as unknown };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [input]);
  const selected = tasks.find((t) => t.name === (task || initialTask));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.ok || !task) return;
    try {
      const run = await start.mutateAsync({ task, input: parsed.value, idempotencyKey: key.trim() || undefined });
      toast.success('Run started', `${run.task} · ${run.id}`);
      onClose();
      navigate(`/w/${ws}/services/${workflowId}/runs/${run.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not start the run');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Run task"
      description="Starts a run on the live deploy. It is queued, then executed in a fresh process with automatic retries."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="run-task" icon={<Play className="size-3.5" />} loading={start.isPending} disabled={!parsed.ok || !task}>
            Start run
          </Button>
        </>
      }
    >
      <form id="run-task" onSubmit={submit} className="space-y-4">
        <Field label="Task" hint={selected ? `${selected.retries} retr${selected.retries === 1 ? 'y' : 'ies'} · ${selected.timeoutSeconds}s timeout${selected.description ? ` · ${selected.description}` : ''}` : undefined}>
          {(id) => <Select id={id} value={task} onChange={(e) => setTask(e.target.value)} options={tasks.map((t) => ({ value: t.name, label: t.name }))} />}
        </Field>
        <Field label="Input (JSON)" error={parsed.ok ? null : parsed.error} hint="Passed to the task function as its first argument. Leave empty for null.">
          {(id) => <Textarea id={id} mono rows={8} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} aria-invalid={!parsed.ok} />}
        </Field>
        <Field label="Idempotency key" optional hint="Starting again with the same key returns the existing run instead of a new one.">
          {(id) => <Input id={id} mono value={key} onChange={(e) => setKey(e.target.value)} placeholder="order-1234" />}
        </Field>
      </form>
    </Dialog>
  );
}

export function WorkflowTasksTab() {
  const { service } = useServiceCtx();
  const { canWrite } = useWorkspace();
  const wf = useWorkflow(service.id);
  const toast = useToast();
  const update = useUpdateWorkflow(service.id);
  const [runTask, setRunTask] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState<string | null>(null);

  if (wf.isPending) return <SkeletonRows rows={4} />;
  if (wf.isError) return <ErrorState error={wf.error} onRetry={() => wf.refetch()} />;
  const tasks = wf.data.tasks;
  const limit = concurrency ?? String(wf.data.maxConcurrency);

  const saveConcurrency = async () => {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) return toast.fromError(new Error('Enter a whole number from 1 to 100'), 'Invalid limit');
    try {
      await update.mutateAsync({ maxConcurrency: n });
      setConcurrency(null);
      toast.success('Concurrency limit saved');
    } catch (e) {
      toast.fromError(e);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[14px] font-semibold">Tasks</h3>
        <p className="text-xs text-fg-subtle">Registered by the live deploy with <code className="font-mono">task(name, options, fn)</code> and discovered when it was deployed.</p>
      </div>
      {!tasks.length ? (
        <Empty
          compact
          icon={<ListTree className="size-5" />}
          title="No tasks yet"
          description={service.currentDeployId ? 'The live deploy registered no tasks.' : 'Tasks appear after the first successful deploy.'}
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Task</Th>
              <Th>Retries</Th>
              <Th>Timeout</Th>
              <Th className="hidden md:table-cell">Backoff</Th>
              <Th className="hidden lg:table-cell">Description</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {tasks.map((t) => (
              <Tr key={t.name}>
                <Td className="font-mono text-[13px] text-fg">{t.name}</Td>
                <Td className="text-fg-muted">{t.retries}</Td>
                <Td className="font-mono text-xs text-fg-muted">{t.timeoutSeconds}s</Td>
                <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">
                  {t.backoffSeconds}s → max {t.maxBackoffSeconds}s
                </Td>
                <Td className="hidden max-w-80 truncate text-xs text-fg-muted lg:table-cell">{t.description ?? '—'}</Td>
                <Td className="text-right">
                  {canWrite && (
                    <Button size="xs" icon={<Play className="size-3" />} onClick={() => setRunTask(t.name)}>
                      Run
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <Card className="p-4">
        <SettingRow title="Max concurrent runs" description="Runs of this workflow executing at once across all nodes. Runs waiting on subtasks or a sleep do not count.">
          <div className="flex items-center gap-2">
            <Input aria-label="Max concurrent runs" className="w-20" type="number" min={1} max={100} value={limit} onChange={(e) => setConcurrency(e.target.value)} disabled={!canWrite} />
            {canWrite && concurrency !== null && (
              <Button size="sm" variant="primary" loading={update.isPending} onClick={saveConcurrency}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
      </Card>
      <Card className="p-4">
        <h4 className="mb-2 text-[13px] font-semibold">Start runs from code or the CLI</h4>
        <CodeBlock
          code={`nav workflows run ${service.slug} ${tasks[0]?.name ?? '<task>'} --input '{"key":"value"}' --wait

// From another service in this workspace (NAV_API_URL and NAV_WORKFLOWS_TOKEN are injected):
import { createClient } from '@nav/workflows';
const run = await createClient().runTask('${service.slug}', '${tasks[0]?.name ?? '<task>'}', { key: 'value' });`}
        />
      </Card>
      {runTask !== null && <RunTaskDialog workflowId={service.id} tasks={tasks} initialTask={runTask} open onClose={() => setRunTask(null)} />}
    </div>
  );
}

export function RunActions({ workflowId, run, size = 'xs' }: { workflowId: string; run: WorkflowRun; size?: 'xs' | 'sm' }) {
  const { canWrite, ws } = useWorkspace();
  const cancel = useCancelWorkflowRun(workflowId);
  const retry = useRetryWorkflowRun(workflowId);
  const toast = useToast();
  const navigate = useNavigate();
  if (!canWrite) return null;
  return (
    <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      {isRunActive(run.status) && (
        <Button
          size={size}
          variant="outline-danger"
          icon={<X className="size-3" />}
          loading={cancel.isPending}
          onClick={async () => {
            try {
              await cancel.mutateAsync(run.id);
              toast.success('Run canceled', 'Unfinished subtasks were canceled too.');
            } catch (err) {
              toast.fromError(err);
            }
          }}
        >
          Cancel
        </Button>
      )}
      {!run.parentRunId && (run.status === 'failed' || run.status === 'canceled') && (
        <Button
          size={size}
          icon={<RotateCcw className="size-3" />}
          loading={retry.isPending}
          onClick={async () => {
            try {
              const next = await retry.mutateAsync(run.id);
              toast.success('Retry started', next.id);
              navigate(`/w/${ws}/services/${workflowId}/runs/${next.id}`);
            } catch (err) {
              toast.fromError(err);
            }
          }}
        >
          Retry
        </Button>
      )}
    </span>
  );
}

export function WorkflowRunsTab() {
  const { service } = useServiceCtx();
  const { ws, canWrite } = useWorkspace();
  const wf = useWorkflow(service.id);
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [task, setTask] = useState('');
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const statuses = STATUS_FILTERS.find((s) => s.value === status)?.statuses;
  const runs = useWorkflowRuns(service.id, { status: statuses, task, all, q: q.trim() });
  const list = useMemo(() => runs.data?.pages.flatMap((p) => p.items) ?? [], [runs.data]);
  useNow(1000, list.some((r) => isRunActive(r.status)));
  const tasks = wf.data?.tasks ?? [];
  const counts = wf.data?.counts;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold">Runs</h3>
          <p className="text-xs text-fg-subtle">
            {counts ? `${counts.running} running · ${counts.waiting} waiting · ${counts.queued} queued · ${counts.succeeded} succeeded · ${counts.failed} failed` : 'Each run executes a task in a fresh process from the live build.'}
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" size="sm" icon={<Play className="size-3.5" />} disabled={!tasks.length} onClick={() => setOpen(true)}>
            Run task
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select size="sm" aria-label="Filter by status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTERS.map(({ value, label }) => ({ value, label }))} />
        <Select size="sm" aria-label="Filter by task" className="w-44" value={task} onChange={(e) => setTask(e.target.value)} options={[{ value: '', label: 'All tasks' }, ...tasks.map((t) => ({ value: t.name, label: t.name }))]} />
        <div className="w-56">
          <Input leading={<Search className="size-3.5" />} placeholder="Run id or idempotency key" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search runs" />
        </div>
        <Checkbox checked={all} onChange={setAll} label="Include subtasks" />
      </div>
      {runs.isPending ? (
        <SkeletonRows rows={5} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : !list.length ? (
        <Empty compact icon={<ListTree className="size-5" />} title="No runs" description={status || task || q ? 'No runs match these filters.' : 'Start a run from the Run task button, the CLI or the API.'} />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Status</Th>
              <Th>Task</Th>
              <Th className="hidden md:table-cell">Run</Th>
              <Th className="hidden lg:table-cell">Input</Th>
              <Th>Attempts</Th>
              <Th className="hidden sm:table-cell">Trigger</Th>
              <Th>Duration</Th>
              <Th className="hidden sm:table-cell">Created</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {list.map((r) => {
              const to = `/w/${ws}/services/${service.id}/runs/${r.id}`;
              return (
                <Tr key={r.id} interactive onClick={() => navigate(to)}>
                  <Td>
                    <StatusPill status={r.status} />
                  </Td>
                  <Td>
                    <Link to={to} className="font-mono text-[13px] text-fg hover:text-accent" onClick={(e) => e.stopPropagation()}>
                      {r.task}
                    </Link>
                    {r.parentRunId && <div className="text-[11px] text-fg-subtle">subtask</div>}
                  </Td>
                  <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{r.id}</Td>
                  <Td className="hidden max-w-60 truncate font-mono text-xs text-fg-muted lg:table-cell">{preview(r.input, 60)}</Td>
                  <Td className={r.attempts > 1 ? 'text-xs text-warning' : 'text-xs text-fg-muted'}>
                    {r.attempts}/{r.maxAttempts}
                  </Td>
                  <Td className="hidden text-xs text-fg-muted sm:table-cell">{r.trigger}</Td>
                  <Td className="font-mono text-xs text-fg-muted">{r.startedAt ? formatDuration(durationBetween(r.startedAt, r.finishedAt)) : '—'}</Td>
                  <Td className="hidden text-xs text-fg-muted sm:table-cell">
                    <RelativeTime value={r.createdAt} />
                  </Td>
                  <Td className="text-right">
                    <RunActions workflowId={service.id} run={r} />
                  </Td>
                </Tr>
              );
            })}
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
      {open && <RunTaskDialog workflowId={service.id} tasks={tasks} open onClose={() => setOpen(false)} />}
    </div>
  );
}
