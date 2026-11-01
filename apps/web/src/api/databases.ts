import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Database, DatabaseCredentials, DbBackup, DbExtension, DbOperation, DbPooler, DbRecoveryWindow, DbReplica, DbSlowQuery, DbTableStat, DbUpgradeInfo, LogLine, Page,
} from '@nav/shared';
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
  highAvailability?: boolean;
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
    refetchInterval: (q) => (q.state.data && ['creating', 'restoring', 'deleting', 'upgrading'].includes(q.state.data.status) ? 5_000 : false),
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

// Advanced Postgres: point-in-time recovery, replicas & HA, pooling, extensions, upgrades, insights ----------

export function useRecoveryWindow(id: string) {
  return useQuery({ queryKey: qk.databaseRecovery(id), queryFn: () => api.get<DbRecoveryWindow>(`/databases/${id}/recovery`), refetchInterval: 60_000 });
}

export function useRecoverDatabase(db: Pick<Database, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { targetTime: string; name?: string }) => api.post<Database>(`/databases/${db.id}/recover`, input),
    onSuccess: (created) => {
      qc.setQueryData(qk.database(created.id), created);
      qc.invalidateQueries({ queryKey: qk.databases(db.workspaceId) });
    },
  });
}

export function useReplicas(id: string) {
  return useQuery({
    queryKey: qk.databaseReplicas(id),
    queryFn: () => api.get<Page<DbReplica>>(`/databases/${id}/replicas`),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'creating' || r.status === 'deleting') ? 3_000 : 10_000),
  });
}

export function useCreateReplica(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name?: string) => api.post<DbReplica>(`/databases/${id}/replicas`, name ? { name } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databaseReplicas(id) }),
  });
}

export function useDeleteReplica(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (replicaId: string) => api.del(`/databases/${id}/replicas/${replicaId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databaseReplicas(id) }),
  });
}

export function usePooler(id: string) {
  return useQuery({ queryKey: qk.databasePooler(id), queryFn: () => api.get<DbPooler>(`/databases/${id}/pooler`) });
}

export function useSetPooler(db: Pick<Database, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => (enabled ? api.post<DbPooler>(`/databases/${db.id}/pooler`) : api.del<DbPooler>(`/databases/${db.id}/pooler`)),
    onSuccess: (data) => {
      qc.setQueryData(qk.databasePooler(db.id), data);
      qc.invalidateQueries({ queryKey: qk.database(db.id), exact: true });
      qc.invalidateQueries({ queryKey: qk.databaseCredentials(db.id) });
    },
  });
}

export function useExtensions(id: string) {
  return useQuery({ queryKey: qk.databaseExtensions(id), queryFn: () => api.get<{ items: DbExtension[] }>(`/databases/${id}/extensions`) });
}

export function useSetExtension(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, install, cascade }: { name: string; install: boolean; cascade?: boolean }): Promise<void> => {
      if (install) await api.post<DbExtension>(`/databases/${id}/extensions`, { name });
      else await api.del(`/databases/${id}/extensions/${name}`, cascade ? { cascade: 'true' } : undefined);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databaseExtensions(id) }),
  });
}

export function useUpgradeInfo(id: string) {
  return useQuery({ queryKey: qk.databaseUpgrade(id), queryFn: () => api.get<DbUpgradeInfo>(`/databases/${id}/upgrade`) });
}

export function useUpgradeDatabase(db: Pick<Database, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.post<DbOperation>(`/databases/${db.id}/upgrade`, { version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.database(db.id) });
      qc.invalidateQueries({ queryKey: qk.databases(db.workspaceId) });
    },
  });
}

export function useDbOperations(id: string) {
  return useQuery({
    queryKey: qk.databaseOperations(id),
    queryFn: () => api.get<Page<DbOperation>>(`/databases/${id}/operations`),
    refetchInterval: (q) => (q.state.data?.items.some((o) => o.status === 'pending' || o.status === 'running') ? 3_000 : false),
  });
}

export function useSlowQueries(id: string, enabled = true) {
  return useQuery({ queryKey: qk.databaseSlowQueries(id), queryFn: () => api.get<{ items: DbSlowQuery[] }>(`/databases/${id}/insights/slow-queries`), enabled, retry: false });
}

export function useResetSlowQueries(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>(`/databases/${id}/insights/slow-queries/reset`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databaseSlowQueries(id) }),
  });
}

export function useTableStats(id: string) {
  return useQuery({ queryKey: qk.databaseTables(id), queryFn: () => api.get<{ items: DbTableStat[] }>(`/databases/${id}/insights/tables`), retry: false });
}

export function useRepackTable(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: { schema: string; table: string }) => api.post<DbOperation>(`/databases/${id}/repack`, t),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databaseOperations(id) }),
  });
}
