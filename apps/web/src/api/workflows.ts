import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogLine, Page, Workflow, WorkflowRun, WorkflowRunDetail, WorkflowRunStatus } from '@nav/shared';
import { WORKFLOW_RUN_ACTIVE } from '@nav/shared';
import { api } from './client';
import { qk } from './keys';

export const isRunActive = (s: WorkflowRunStatus) => WORKFLOW_RUN_ACTIVE.includes(s);

export interface RunFilters {
  status?: WorkflowRunStatus[];
  task?: string;
  /** Include subtask runs (default: top-level runs only). */
  all?: boolean;
  q?: string;
}

export function useWorkflows(ws: string) {
  return useQuery({
    queryKey: qk.workflows(ws),
    queryFn: () => api.get<Page<Workflow>>(`/workspaces/${ws}/workflows`),
    placeholderData: keepPreviousData,
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    queryKey: qk.workflow(id),
    queryFn: () => api.get<Workflow>(`/workflows/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && (q.state.data.counts.running || q.state.data.counts.queued || q.state.data.counts.waiting) ? 5_000 : 30_000),
  });
}

export function useWorkflowRuns(id: string, f: RunFilters, limit = 50) {
  const filters = { status: f.status?.join(',') || undefined, task: f.task || undefined, scope: f.all ? 'all' : undefined, q: f.q || undefined };
  return useInfiniteQuery({
    queryKey: qk.workflowRuns(id, filters),
    queryFn: ({ pageParam }) => api.get<Page<WorkflowRun>>(`/workflows/${id}/runs`, { ...filters, cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some((r) => isRunActive(r.status))) ? 3_000 : 15_000),
  });
}

export function useWorkflowRun(runId: string) {
  return useQuery({
    queryKey: qk.workflowRun(runId),
    queryFn: () => api.get<WorkflowRunDetail>(`/workflow-runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && q.state.data.tree.some((r) => isRunActive(r.status)) ? 2_000 : false),
  });
}

export function useWorkflowRunLogs(runId: string | null, live: boolean) {
  return useQuery({
    queryKey: qk.workflowRunLogs(runId ?? ''),
    queryFn: () => api.get<{ items: LogLine[] }>(`/workflow-runs/${runId}/logs`),
    enabled: !!runId,
    refetchInterval: live ? 2_000 : false,
  });
}

function useInvalidateWorkflow(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: qk.workflow(id) });
    qc.invalidateQueries({ queryKey: qk.workflowRuns(id) });
  };
}

export function useStartWorkflowRun(id: string) {
  const inv = useInvalidateWorkflow(id);
  return useMutation({
    mutationFn: (body: { task: string; input: unknown; idempotencyKey?: string }) =>
      api.post<WorkflowRun>(`/workflows/${id}/tasks/${encodeURIComponent(body.task)}/runs`, {
        input: body.input,
        trigger: 'dashboard',
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      }),
    onSuccess: inv,
  });
}

export function useCancelWorkflowRun(id: string) {
  const inv = useInvalidateWorkflow(id);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post<WorkflowRun>(`/workflow-runs/${runId}/cancel`),
    onSuccess: (run) => {
      inv();
      qc.invalidateQueries({ queryKey: qk.workflowRun(run.id) });
      if (run.rootRunId) qc.invalidateQueries({ queryKey: qk.workflowRun(run.rootRunId) });
    },
  });
}

export function useRetryWorkflowRun(id: string) {
  const inv = useInvalidateWorkflow(id);
  return useMutation({
    mutationFn: (runId: string) => api.post<WorkflowRun>(`/workflow-runs/${runId}/retry`),
    onSuccess: inv,
  });
}

export function useUpdateWorkflow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { maxConcurrency: number }) => api.patch<Workflow>(`/workflows/${id}`, body),
    onSuccess: (data) => qc.setQueryData(qk.workflow(id), data),
  });
}
