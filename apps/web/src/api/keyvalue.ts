import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Plan } from '@nav/shared';
import { api } from './client';
import { qk } from './keys';
import type { KeyValue, KeyValueCredentials } from './types';

export interface CreateKeyValueInput {
  name: string;
  plan: string;
  maxmemoryPolicy: string;
  ipAllowList: KeyValue['ipAllowList'];
  environmentId?: string | null;
}

export type UpdateKeyValueInput = Partial<Pick<KeyValue, 'name' | 'plan' | 'maxmemoryPolicy' | 'ipAllowList'>>;

export function useKeyValuePlans() {
  return useQuery({
    queryKey: qk.keyValuePlans,
    queryFn: () => api.get<{ plans: Plan[]; policies: string[] }>('/key-value-plans'),
    staleTime: 60 * 60_000,
  });
}

export function useKeyValues(ws: string) {
  return useQuery({
    queryKey: qk.keyValues(ws),
    queryFn: () => api.get<{ items: KeyValue[] }>(`/workspaces/${ws}/key-value`),
    refetchInterval: (q) => (q.state.data?.items.some((k) => k.status === 'creating' || k.status === 'deleting') ? 5_000 : false),
  });
}

export function useKeyValue(id: string | undefined) {
  return useQuery({
    queryKey: qk.keyValue(id ?? ''),
    queryFn: () => api.get<KeyValue>(`/key-value/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['creating', 'deleting'].includes(q.state.data.status) ? 5_000 : false),
  });
}

export function useCreateKeyValue(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateKeyValueInput) => api.post<KeyValue>(`/workspaces/${ws}/key-value`, input),
    onSuccess: (kv) => {
      qc.setQueryData(qk.keyValue(kv.id), kv);
      qc.invalidateQueries({ queryKey: qk.keyValues(ws) });
    },
  });
}

export function useUpdateKeyValue(kv: Pick<KeyValue, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateKeyValueInput) => api.patch<KeyValue>(`/key-value/${kv.id}`, input),
    onSuccess: (data) => {
      qc.setQueryData(qk.keyValue(kv.id), data);
      qc.invalidateQueries({ queryKey: qk.keyValues(kv.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.keyValueCredentials(kv.id) });
    },
  });
}

export function useDeleteKeyValue(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/key-value/${id}`),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.keyValue(id) });
      qc.invalidateQueries({ queryKey: qk.keyValues(ws) });
    },
  });
}

export function useKeyValueAction(kv: Pick<KeyValue, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'suspend' | 'resume') => api.post<KeyValue>(`/key-value/${kv.id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.keyValue(kv.id), exact: true });
      qc.invalidateQueries({ queryKey: qk.keyValues(kv.workspaceId) });
    },
  });
}

/** Unmasked connection strings; only requested when the user reveals or copies them. */
export function useKeyValueCredentials(id: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.keyValueCredentials(id),
    queryFn: () => api.get<KeyValueCredentials>(`/key-value/${id}/credentials`),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useKeyValueLogs(id: string, live: boolean) {
  return useQuery({
    queryKey: qk.keyValueLogs(id),
    queryFn: () => api.get<{ items: { id: number; ts: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string }[] }>(`/key-value/${id}/logs`),
    refetchInterval: live ? 5_000 : false,
  });
}
