import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Blueprint, BlueprintInspection, EnvGroup, EnvVar, Page, PreviewEnvironment, SecretFile } from '@nav/shared';
import { api } from './client';
import { qk } from './keys';
import type { BlueprintValidateResult } from './types';

// Env groups -----------------------------------------------------------------------------------

export function useEnvGroups(ws: string) {
  return useQuery({
    queryKey: qk.envGroups(ws),
    queryFn: () => api.get<Page<EnvGroup>>(`/workspaces/${ws}/env-groups`, { limit: 200 }),
  });
}

export function useEnvGroup(id: string | undefined) {
  return useQuery({
    queryKey: qk.envGroup(id ?? ''),
    queryFn: () => api.get<EnvGroup>(`/env-groups/${id}`),
    enabled: !!id,
    refetchOnWindowFocus: false,
  });
}

export function useCreateEnvGroup(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; envVars?: EnvVar[]; secretFiles?: SecretFile[] }) => api.post<EnvGroup>(`/workspaces/${ws}/env-groups`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.envGroups(ws) }),
  });
}

export function useUpdateEnvGroup(ws: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; envVars?: EnvVar[]; secretFiles?: SecretFile[] }) => api.patch<EnvGroup>(`/env-groups/${id}`, body),
    onSuccess: (data) => {
      qc.setQueryData(qk.envGroup(id), data);
      qc.invalidateQueries({ queryKey: qk.envGroups(ws) });
    },
  });
}

export function useDeleteEnvGroup(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/env-groups/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.envGroups(ws) }),
  });
}

// Blueprints -------------------------------------------------------------------------------------

export function useBlueprints(ws: string) {
  return useQuery({
    queryKey: qk.blueprints(ws),
    queryFn: () => api.get<Page<Blueprint>>(`/workspaces/${ws}/blueprints`, { limit: 100 }),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === 'syncing' || b.status === 'pending') ? 5_000 : false),
  });
}

export function useBlueprint(id: string | undefined) {
  return useQuery({
    queryKey: qk.blueprint(id ?? ''),
    queryFn: () => api.get<Blueprint>(`/blueprints/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'syncing' || q.state.data.status === 'pending') ? 4_000 : false),
  });
}

export function useCreateBlueprint(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; repoUrl: string; branch: string; filePath?: string }) => api.post<Blueprint>(`/workspaces/${ws}/blueprints`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.blueprints(ws) }),
  });
}

export function useSyncBlueprint(ws: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>(`/blueprints/${id}/sync`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.blueprint(id) });
      qc.invalidateQueries({ queryKey: qk.blueprints(ws) });
    },
  });
}

export function useUpdateBlueprint(ws: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<Blueprint, 'name' | 'branch' | 'filePath' | 'autoSync' | 'previews'>>) => api.patch<Blueprint>(`/blueprints/${id}`, body),
    onSuccess: (data) => {
      qc.setQueryData(qk.blueprint(id), data);
      qc.invalidateQueries({ queryKey: qk.blueprints(ws) });
    },
  });
}

export function useDeleteBlueprint(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteResources }: { id: string; deleteResources: boolean }) =>
      api.del(`/blueprints/${id}`, { deleteResources: deleteResources ? 1 : undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.blueprints(ws) });
      qc.invalidateQueries({ queryKey: qk.services(ws) });
      qc.invalidateQueries({ queryKey: qk.databases(ws) });
    },
  });
}

export function useValidateBlueprint() {
  return useMutation({
    mutationFn: (yaml: string) => api.post<BlueprintValidateResult>('/blueprints/validate', { yaml }),
  });
}

/** "Deploy to NAV": what a repository's blueprint file would create. */
export function useInspectBlueprint(repoUrl: string | null, branch?: string | null) {
  return useQuery({
    queryKey: ['blueprint-inspect', repoUrl, branch ?? null] as const,
    queryFn: () => api.post<BlueprintInspection>('/blueprints/inspect', { repoUrl, branch: branch || undefined }),
    enabled: !!repoUrl,
    retry: false,
    staleTime: 60_000,
  });
}

// Blueprint preview environments ---------------------------------------------------------------------

export function useBlueprintPreviews(id: string) {
  return useQuery({
    queryKey: qk.blueprintPreviews(id),
    queryFn: () => api.get<Page<PreviewEnvironment>>(`/blueprints/${id}/previews`),
    enabled: !!id,
  });
}

export function useDeleteBlueprintPreview(blueprintId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (previewId: string) => api.del(`/blueprint-previews/${previewId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.blueprintPreviews(blueprintId) }),
  });
}
