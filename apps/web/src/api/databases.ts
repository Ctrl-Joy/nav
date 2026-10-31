import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Database, DatabaseCredentials, DbBackup, LogLine, Page } from '@nav/shared';
import { api } from './client';
import { qk, type MetricsRange } from './keys';
import type { DbMetricsResponse, QueryResult } from './types';

export interface CreateDatabaseInput {
  name: string;
  plan?: string;
  pgVersion?: number;
  databaseName?: string;
  user?: string;
  environmentId?: string | null;
  diskGB?: number;
}

export interface UpdateDatabaseInput {
  name?: string;
  plan?: string;
  ipAllowList?: Database['ipAllowList'];
  diskGB?: number;
}

export function useDatabases(ws: string) {
  return useQuery({
    queryKey: qk.databases(ws),
    queryFn: () => api.get<Page<Database>>(`/workspaces/${ws}/databases`, { limit: 200 }),
  });
}

export function useDatabase(id: string | undefined) {
  return useQuery({
    queryKey: qk.database(id ?? ''),
    queryFn: () => api.get<Database>(`/databases/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['creating', 'restoring', 'deleting'].includes(q.state.data.status) ? 5_000 : false),
  });
}

export function useCreateDatabase(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDatabaseInput) => api.post<Database>(`/workspaces/${ws}/databases`, input),
    onSuccess: (db) => {
      qc.setQueryData(qk.database(db.id), db);
      qc.invalidateQueries({ queryKey: qk.databases(ws) });
    },
  });
}

export function useUpdateDatabase(db: Pick<Database, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDatabaseInput) => api.patch<Database>(`/databases/${db.id}`, input),
    onSuccess: (data) => {
      qc.setQueryData(qk.database(db.id), data);
      qc.invalidateQueries({ queryKey: qk.databases(db.workspaceId) });
    },
  });
}

export function useDeleteDatabase(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/databases/${id}`),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.database(id) });
      qc.invalidateQueries({ queryKey: qk.databases(ws) });
    },
  });
}

export function useDatabaseAction(db: Pick<Database, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'suspend' | 'resume' | 'restart') => api.post<unknown>(`/databases/${db.id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.database(db.id), exact: true });
      qc.invalidateQueries({ queryKey: qk.databases(db.workspaceId) });
    },
  });
}

export function useDatabaseCredentials(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.databaseCredentials(id),
    queryFn: () => api.get<DatabaseCredentials>(`/databases/${id}/credentials`),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useBackups(id: string) {
  return useQuery({
    queryKey: qk.databaseBackups(id),
    queryFn: () => api.get<Page<DbBackup>>(`/databases/${id}/backups`, { limit: 100 }),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === 'pending' || b.status === 'running') ? 5_000 : false),
  });
}

export function useCreateBackup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DbBackup>(`/databases/${id}/backups`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databaseBackups(id) }),
  });
}

export function useRestoreBackup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => api.post<unknown>(`/databases/${id}/backups/${backupId}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.database(id) }),
  });
}

export function backupDownloadUrl(dbId: string, backupId: string): string {
  return `/api/v1/databases/${dbId}/backups/${backupId}/download`;
}

export function useDatabaseMetrics(id: string, range: MetricsRange) {
  return useQuery({
    queryKey: qk.databaseMetrics(id, range),
    queryFn: () => api.get<DbMetricsResponse>(`/databases/${id}/metrics`, { range }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function fetchDatabaseLogs(id: string, query: { before?: number; after?: number; q?: string; level?: string; limit?: number }, signal?: AbortSignal) {
  return api.get<{ items: LogLine[] }>(`/databases/${id}/logs`, { ...query }, signal);
}

export function useRunQuery(id: string) {
  return useMutation({
    mutationFn: (sql: string) => api.post<QueryResult>(`/databases/${id}/query`, { sql }),
  });
}
