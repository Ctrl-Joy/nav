import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKey, Page } from '@nav/shared';
import { api, isApiError, request } from './client';
import { qk } from './keys';
import type { AppConfig, CreateApiKeyResponse, MeResponse } from './types';

export function useConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: () => request<AppConfig>('/config', { skipAuthRedirect: true }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Current user; resolves to `null` when signed out (never redirects). */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await request<MeResponse>('/auth/me', { skipAuthRedirect: true });
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (count, e) => !(isApiError(e) && e.status < 500) && count < 2,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      request<MeResponse>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
    onSuccess: (data) => {
      qc.setQueryData(qk.me, data);
    },
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string; name: string }) =>
      request<MeResponse>('/auth/signup', { method: 'POST', body, skipAuthRedirect: true }),
    onSuccess: (data) => {
      qc.setQueryData(qk.me, data);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>('/auth/logout', { method: 'POST', body: {}, skipAuthRedirect: true }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(qk.me, null);
    },
  });
}

export function useApiKeys() {
  return useQuery({ queryKey: qk.apiKeys, queryFn: () => api.get<Page<ApiKey>>('/api-keys') });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<CreateApiKeyResponse>('/api-keys', { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys }),
  });
}

export const GITHUB_LOGIN_URL = '/api/v1/auth/github';
