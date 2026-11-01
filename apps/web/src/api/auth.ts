import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKey, Page } from '@nav/shared';
import { api, isApiError, request } from './client';
import { qk } from './keys';
import {
  isMfaChallenge,
  type AppConfig,
  type AuthProvider,
  type CreateApiKeyResponse,
  type IdentityInfo,
  type MeResponse,
  type MfaChallenge,
  type MfaLoginResponse,
  type SessionInfo,
} from './types';

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
      request<MeResponse | MfaChallenge>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
    onSuccess: (data) => {
      if (!isMfaChallenge(data)) qc.setQueryData(qk.me, data);
    },
  });
}

/** Second sign-in step: an authenticator code or a recovery code for the challenge cookie. */
export function useLoginMfa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => request<MfaLoginResponse>('/auth/login/mfa', { method: 'POST', body: { code }, skipAuthRedirect: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string; name?: string }) =>
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

/** Where the browser goes to start signing in (or connecting) with a provider. */
export function providerUrl(p: AuthProvider, opts: { mode?: 'connect'; next?: string | null } = {}): string {
  const base = p === 'github' ? GITHUB_LOGIN_URL : `/api/v1/auth/oauth/${p}/start`;
  const qs = new URLSearchParams();
  if (opts.mode) qs.set('mode', opts.mode);
  if (opts.next) qs.set('next', opts.next);
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) => request<{ ok: true }>('/auth/password/forgot', { method: 'POST', body: { email }, skipAuthRedirect: true }),
  });
}

export function useResetToken(token: string | null) {
  return useQuery({
    queryKey: ['auth', 'reset', token],
    queryFn: () => request<{ email: string }>(`/auth/password/reset/${encodeURIComponent(token ?? '')}`, { skipAuthRedirect: true }),
    enabled: !!token,
    retry: false,
  });
}

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      request<MeResponse | MfaChallenge>('/auth/password/reset', { method: 'POST', body, skipAuthRedirect: true }),
    onSuccess: (data) => {
      if (!isMfaChallenge(data)) qc.setQueryData(qk.me, data);
    },
  });
}

export function useSsoLookup() {
  return useMutation({
    mutationFn: (email: string) => request<{ redirect: string }>('/auth/sso', { method: 'POST', body: { email }, skipAuthRedirect: true }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; avatarUrl?: string | null; emailNotifications?: boolean }) => api.patch<Pick<MeResponse, 'user'>>('/auth/me', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

// Two-factor authentication ------------------------------------------------------------------

export function useMfaSetup() {
  return useMutation({ mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup') });
}

export function useMfaEnable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<{ enabled: true; recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.me });
      qc.invalidateQueries({ queryKey: qk.sessions });
    },
  });
}

/** Turning 2FA off takes a current code, or the account password. */
export function useMfaDisable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code?: string; password?: string }) => api.post<{ enabled: false }>('/auth/mfa/disable', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code?: string; password?: string }) => api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useChangeEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; currentPassword?: string }) => api.post<Pick<MeResponse, 'user'>>('/auth/me/email', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { currentPassword?: string; newPassword: string }) => api.post<{ ok: true }>('/auth/password/change', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.me });
      qc.invalidateQueries({ queryKey: qk.sessions });
    },
  });
}

export function useSessions() {
  return useQuery({ queryKey: qk.sessions, queryFn: () => api.get<{ items: SessionInfo[] }>('/auth/sessions') });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | 'others') => api.del(id === 'others' ? '/auth/sessions' : `/auth/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useIdentities() {
  return useQuery({
    queryKey: qk.identities,
    queryFn: () => api.get<{ items: IdentityInfo[]; available: Partial<Record<AuthProvider, boolean>> }>('/auth/identities'),
  });
}

export function useDisconnectIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: AuthProvider) => api.del(`/auth/identities/${p}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.identities });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { confirm: string; password?: string }) => request<void>('/auth/me', { method: 'DELETE', body }),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(qk.me, null);
    },
  });
}
