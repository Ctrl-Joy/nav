import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Sandbox, SandboxExecResult, SandboxFileEntry, SandboxPlan, SandboxRuntime, SandboxSnapshot } from '@nav/shared';
import { API_BASE, ApiRequestError, api, buildUrl } from './client';

export interface CreateSandboxInput {
  name?: string;
  runtime?: SandboxRuntime;
  image?: string;
  plan: string;
  ttlSeconds: number;
  env: Record<string, string>;
  networkAccess: 'none' | 'egress';
  snapshotId?: string;
}

const keys = {
  meta: ['sandbox-plans'] as const,
  list: (ws: string) => ['ws', ws, 'sandboxes'] as const,
  one: (id: string) => ['sandbox', id] as const,
  files: (id: string, path: string) => ['sandbox', id, 'files', path] as const,
  snapshots: (ws: string) => ['ws', ws, 'sandbox-snapshots'] as const,
};

export function useSandboxMeta() {
  return useQuery({
    queryKey: keys.meta,
    queryFn: () => api.get<{ plans: SandboxPlan[]; images: Record<SandboxRuntime, string>; limits: Record<string, number> }>('/sandbox-plans'),
    staleTime: 60 * 60_000,
  });
}

export function useSandboxes(ws: string, status: 'live' | 'all') {
  return useQuery({
    queryKey: [...keys.list(ws), status],
    queryFn: () => api.get<{ items: Sandbox[] }>(`/workspaces/${ws}/sandboxes`, { status }),
    refetchInterval: 15_000,
  });
}

export function useSandbox(id: string | undefined) {
  return useQuery({
    queryKey: keys.one(id ?? ''),
    queryFn: () => api.get<Sandbox>(`/sandboxes/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['starting', 'running', 'stopping'].includes(q.state.data.status) ? 10_000 : false),
  });
}

export function useCreateSandbox(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSandboxInput) => api.post<Sandbox>(`/workspaces/${ws}/sandboxes`, input),
    onSuccess: (sb) => {
      qc.setQueryData(keys.one(sb.id), sb);
      qc.invalidateQueries({ queryKey: keys.list(ws) });
    },
  });
}

export function useDeleteSandbox(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/sandboxes/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: keys.one(id) });
      qc.invalidateQueries({ queryKey: keys.list(ws) });
    },
  });
}

export function useSandboxExec(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { command: string; cwd?: string; timeoutSeconds?: number }) => api.post<SandboxExecResult>(`/sandboxes/${id}/exec`, input),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.one(id) }),
  });
}

export function useSandboxFiles(id: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.files(id, path),
    queryFn: () => api.get<{ items: SandboxFileEntry[] }>(`/sandboxes/${id}/ls`, { path }),
    enabled,
    retry: false,
  });
}

export function useSandboxFileActions(id: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['sandbox', id, 'files'] });
  const upload = useMutation({
    mutationFn: async ({ path, file }: { path: string; file: Blob }) => {
      const res = await fetch(buildUrl(`/sandboxes/${id}/files`, { path }), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-NAV-CSRF': '1' },
        credentials: 'include',
        body: file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiRequestError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText);
      }
      return res.json() as Promise<{ size: number }>;
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: ({ path, recursive }: { path: string; recursive: boolean }) => api.del(`/sandboxes/${id}/files`, { path, recursive: recursive ? '1' : '0' }),
    onSuccess: refresh,
  });
  return { upload, remove, refresh };
}

/** A plain link: the browser sends the session cookie with GETs. */
export const sandboxDownloadUrl = (id: string, path: string) => `${API_BASE}/sandboxes/${id}/files?${new URLSearchParams({ path })}`;

export function useSandboxSnapshots(ws: string) {
  return useQuery({
    queryKey: keys.snapshots(ws),
    queryFn: () => api.get<{ items: SandboxSnapshot[] }>(`/workspaces/${ws}/sandbox-snapshots`),
  });
}

export function useSnapshotActions(ws: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.snapshots(ws) });
  const take = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) => api.post<SandboxSnapshot>(`/sandboxes/${id}/snapshots`, name ? { name } : {}),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (snapId: string) => api.del(`/sandbox-snapshots/${snapId}`), onSuccess: refresh });
  return { take, remove };
}
