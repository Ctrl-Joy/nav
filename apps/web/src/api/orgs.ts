import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { qk } from './keys';
import type { AuditLogEntry, OrgDetail, OrgDomain, OrgMember, OrgRole, OrgWorkspace, SamlSettings, SamlUpdate, ScimSettings } from './types';

// Organizations ------------------------------------------------------------------------------

export function useOrg(org: string | undefined) {
  return useQuery({ queryKey: qk.org(org ?? ''), queryFn: () => api.get<OrgDetail>(`/orgs/${org}`), enabled: !!org });
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; workspaceId?: string }) => api.post<OrgDetail>('/orgs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useUpdateOrg(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; requireTwoFactor?: boolean; defaultWorkspaceId?: string | null; defaultRole?: OrgDetail['defaultRole'] }) => api.patch<OrgDetail>(`/orgs/${org}`, body),
    onSuccess: (data) => {
      qc.setQueryData(qk.org(org), data);
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

// Members ------------------------------------------------------------------------------------

export function useOrgMembers(org: string) {
  return useQuery({ queryKey: qk.orgMembers(org), queryFn: () => api.get<{ items: OrgMember[] }>(`/orgs/${org}/members`) });
}

export function useAddOrgMember(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: OrgRole }) => api.post(`/orgs/${org}/members`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgMembers(org) }),
  });
}

export function useUpdateOrgMember(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) => api.patch(`/orgs/${org}/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgMembers(org) }),
  });
}

export function useRemoveOrgMember(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.del(`/orgs/${org}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.orgMembers(org) });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

// Workspaces ---------------------------------------------------------------------------------

export function useOrgWorkspaces(org: string) {
  return useQuery({ queryKey: qk.orgWorkspaces(org), queryFn: () => api.get<{ items: OrgWorkspace[] }>(`/orgs/${org}/workspaces`) });
}

function useOrgWorkspaceMutation<T, R>(org: string, fn: (v: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.orgWorkspaces(org) });
      qc.invalidateQueries({ queryKey: qk.org(org) });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export const useCreateOrgWorkspace = (org: string) => useOrgWorkspaceMutation(org, (name: string) => api.post<{ id: string; name: string }>(`/orgs/${org}/workspaces`, { name }));
export const useAttachWorkspace = (org: string) => useOrgWorkspaceMutation(org, (workspaceId: string) => api.post(`/orgs/${org}/workspaces/${workspaceId}/attach`));
export const useDetachWorkspace = (org: string) => useOrgWorkspaceMutation(org, (workspaceId: string) => api.post(`/orgs/${org}/workspaces/${workspaceId}/detach`));

// Domains ------------------------------------------------------------------------------------

export function useOrgDomains(org: string) {
  return useQuery({ queryKey: qk.orgDomains(org), queryFn: () => api.get<{ items: OrgDomain[] }>(`/orgs/${org}/domains`) });
}

export function useAddOrgDomain(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => api.post<OrgDomain>(`/orgs/${org}/domains`, { domain }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgDomains(org) }),
  });
}

export function useVerifyOrgDomain(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => api.post<OrgDomain>(`/orgs/${org}/domains/${domainId}/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgDomains(org) }),
  });
}

export function useDeleteOrgDomain(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => api.del(`/orgs/${org}/domains/${domainId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.orgDomains(org) });
      qc.invalidateQueries({ queryKey: qk.orgSaml(org) });
    },
  });
}

// SAML ---------------------------------------------------------------------------------------

export function useOrgSaml(org: string) {
  return useQuery({ queryKey: qk.orgSaml(org), queryFn: () => api.get<SamlSettings>(`/orgs/${org}/saml`) });
}

export function useUpdateOrgSaml(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SamlUpdate) => api.put<SamlSettings>(`/orgs/${org}/saml`, body),
    onSuccess: (data) => qc.setQueryData(qk.orgSaml(org), data),
  });
}

export function useDeleteOrgSaml(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/orgs/${org}/saml`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgSaml(org) }),
  });
}

// SCIM ---------------------------------------------------------------------------------------

export function useOrgScim(org: string) {
  return useQuery({ queryKey: qk.orgScim(org), queryFn: () => api.get<ScimSettings>(`/orgs/${org}/scim`) });
}

export function useCreateScimToken(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ id: string; token: string; baseUrl: string }>(`/orgs/${org}/scim/tokens`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgScim(org) }),
  });
}

export function useRevokeScimToken(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api.del(`/orgs/${org}/scim/tokens/${tokenId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgScim(org) }),
  });
}

export function useMapScimGroup(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, workspaceId, role }: { groupId: string; workspaceId: string | null; role: 'admin' | 'developer' | 'viewer' | null }) =>
      api.patch(`/orgs/${org}/scim/groups/${groupId}`, { workspaceId, role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.orgScim(org) }),
  });
}

// Audit log ----------------------------------------------------------------------------------

export function useOrgAuditLogs(org: string, filters: { action?: string; actor?: string }, limit = 50) {
  return useInfiniteQuery({
    queryKey: qk.orgAuditLogs(org, filters),
    queryFn: ({ pageParam }) =>
      api.get<{ items: AuditLogEntry[]; nextBefore: number | null }>(`/orgs/${org}/audit-logs`, { before: pageParam, limit, action: filters.action, actor: filters.actor }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
}
