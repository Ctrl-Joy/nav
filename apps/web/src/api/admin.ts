import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { qk } from './keys';

export type ConfigurableProvider = 'github' | 'gitlab' | 'bitbucket' | 'google';

/** GET /admin/auth-providers item. Secrets are never returned, only whether one is set. */
export interface AuthProviderSettings {
  provider: ConfigurableProvider;
  name: string;
  enabled: boolean;
  source: 'environment' | 'database' | null;
  readOnly: boolean;
  clientIdHint: string | null;
  clientSecretSet: boolean;
  baseUrl: string | null;
  callbackUrl: string;
  scopes: string[];
  envVars: string[];
  saved: { updatedAt: string; updatedBy: string | null; unreadable: boolean } | null;
}

export interface ProviderCheck {
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
}

export interface ProviderTestResult {
  ok: boolean | null;
  summary: string;
  checks: ProviderCheck[];
}

const key = ['admin', 'auth-providers'] as const;

export function useAuthProviders(enabled = true) {
  return useQuery({ queryKey: key, queryFn: () => api.get<{ items: AuthProviderSettings[] }>('/admin/auth-providers'), enabled });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: qk.config });
    qc.invalidateQueries({ queryKey: qk.identities });
  };
}

export function useSaveAuthProvider(p: ConfigurableProvider) {
  const invalidate = useInvalidate();
  return useMutation({
    /** Blank fields keep the saved value. */
    mutationFn: (body: { clientId?: string; clientSecret?: string; baseUrl?: string | null }) => api.put<AuthProviderSettings>(`/admin/auth-providers/${p}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteAuthProvider(p: ConfigurableProvider) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api.del(`/admin/auth-providers/${p}`), onSuccess: invalidate });
}

/** Checks the typed (unsaved) values, falling back to what is saved. */
export function useTestAuthProvider(p: ConfigurableProvider) {
  return useMutation({
    mutationFn: (body: { clientId?: string; clientSecret?: string; baseUrl?: string | null }) => api.post<ProviderTestResult>(`/admin/auth-providers/${p}/test`, body),
  });
}
