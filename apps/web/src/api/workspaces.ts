import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Environment, Event as NavEvent, Member, Page, Project, Repo, Role, Workspace } from '@nav/shared';
import { api } from './client';
import { qk } from './keys';
import type { AddMemberResponse, NotificationSettings, WorkspaceInfo } from './types';

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: () => api.get<Page<Workspace>>('/workspaces') });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<Workspace>('/workspaces', { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useUpdateWorkspace(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; requireTwoFactor?: boolean }) => api.patch<WorkspaceInfo>(`/workspaces/${ws}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

// Members ----------------------------------------------------------------------------------

export function useMembers(ws: string) {
  return useQuery({ queryKey: qk.members(ws), queryFn: () => api.get<Page<Member>>(`/workspaces/${ws}/members`) });
}

export function useAddMember(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: Role }) => api.post<AddMemberResponse>(`/workspaces/${ws}/members`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(ws) }),
  });
}

export function useUpdateMember(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.patch<Member>(`/workspaces/${ws}/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(ws) }),
  });
}

export function useRemoveMember(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.del(`/workspaces/${ws}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(ws) }),
  });
}

// Projects & environments ------------------------------------------------------------------

export function useProjects(ws: string) {
  return useQuery({ queryKey: qk.projects(ws), queryFn: () => api.get<Page<Project>>(`/workspaces/${ws}/projects`, { limit: 100 }) });
}

export function useCreateProject(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; environments?: string[] }) => api.post<Project>(`/workspaces/${ws}/projects`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(ws) }),
  });
}

export function useRenameProject(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<Project>(`/projects/${id}`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(ws) }),
  });
}

export function useDeleteProject(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.projects(ws) });
      qc.invalidateQueries({ queryKey: qk.services(ws) });
    },
  });
}

export function useAddEnvironment(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name, protected: prot }: { projectId: string; name: string; protected?: boolean }) =>
      api.post<Environment>(`/projects/${projectId}/environments`, { name, protected: prot }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(ws) }),
  });
}

export function useDeleteEnvironment(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/environments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(ws) }),
  });
}

// Activity -----------------------------------------------------------------------------------

export function useWorkspaceEvents(ws: string, limit = 50) {
  return useInfiniteQuery({
    queryKey: qk.wsEvents(ws),
    queryFn: ({ pageParam }) => api.get<Page<NavEvent>>(`/workspaces/${ws}/events`, { cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

// Notifications ----------------------------------------------------------------------------

export function useNotifications(ws: string) {
  return useQuery({
    queryKey: qk.notifications(ws),
    queryFn: () => api.get<NotificationSettings>(`/workspaces/${ws}/notifications`),
  });
}

export function useUpdateNotifications(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationSettings) => api.put<NotificationSettings>(`/workspaces/${ws}/notifications`, body),
    onSuccess: (data) => qc.setQueryData(qk.notifications(ws), data),
  });
}

// Git ----------------------------------------------------------------------------------------

export function useRepos(ws: string, enabled = true) {
  return useQuery({
    queryKey: qk.repos(ws),
    queryFn: () => api.get<Page<Repo>>(`/workspaces/${ws}/repos`, { limit: 100 }),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

export function useBranches(repoUrl: string | null | undefined) {
  const typed = repoUrl?.trim() ?? '';
  // Wait until typing pauses, so a half-typed URL is never sent to the server (it answered each one with a 400).
  const [url, setUrl] = useState(typed);
  useEffect(() => {
    const t = window.setTimeout(() => setUrl(typed), 400);
    return () => window.clearTimeout(t);
  }, [typed]);
  return useQuery({
    queryKey: qk.branches(url),
    queryFn: () => api.get<{ items: string[] }>('/git/branches', { repoUrl: url }),
    // A complete-looking remote: scheme, host and a path, or an scp-style git@host:path.
    enabled: url === typed && /^((https?|ssh):\/\/[^\s/]+\/\S+|git@[^\s:]+:\S+)$/.test(url),
    retry: false,
    staleTime: 60_000,
  });
}
