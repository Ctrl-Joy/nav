import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { qk } from './keys';
import type { AuditLogEntry, LogStream, LogStreamInput, MetricsStream, OutboundWebhook, RegistryCredential, WebhookDelivery } from './types';

// Webhooks -----------------------------------------------------------------------------------

export interface WebhookInput {
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
}

export function useWebhookEvents() {
  return useQuery({
    queryKey: qk.webhookEvents,
    queryFn: () => api.get<{ items: string[] }>('/webhook-events'),
    staleTime: 60 * 60_000,
  });
}

export function useWebhooks(ws: string, enabled = true) {
  return useQuery({
    queryKey: qk.webhooks(ws),
    queryFn: () => api.get<{ items: OutboundWebhook[] }>(`/workspaces/${ws}/webhooks`),
    enabled,
  });
}

export function useCreateWebhook(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WebhookInput) => api.post<{ webhook: OutboundWebhook; secret: string }>(`/workspaces/${ws}/webhooks`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.webhooks(ws) }),
  });
}

export function useUpdateWebhook(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<WebhookInput> & { id: string }) => api.patch<{ webhook: OutboundWebhook }>(`/webhooks/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.webhooks(ws) }),
  });
}

export function useDeleteWebhook(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/webhooks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.webhooks(ws) }),
  });
}

/** Signing secret, fetched only when the user asks to reveal it. */
export function useWebhookSecret(id: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.webhookSecret(id),
    queryFn: () => api.get<{ secret: string }>(`/webhooks/${id}/secret`),
    enabled,
    retry: false,
    staleTime: Infinity,
  });
}

export function useRotateWebhookSecret(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ secret: string }>(`/webhooks/${id}/rotate-secret`),
    onSuccess: (data) => qc.setQueryData(qk.webhookSecret(id), data),
  });
}

export function useWebhookDeliveries(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.webhookDeliveries(id),
    queryFn: () => api.get<{ items: WebhookDelivery[] }>(`/webhooks/${id}/deliveries`),
    enabled,
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.status === 'pending') ? 5_000 : false),
  });
}

export function useTestWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ delivery: WebhookDelivery }>(`/webhooks/${id}/test`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.webhookDeliveries(id) }),
  });
}

export function useRetryDelivery(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: number) => api.post<{ delivery: WebhookDelivery }>(`/webhooks/${id}/deliveries/${deliveryId}/retry`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.webhookDeliveries(id) }),
  });
}

// Log streams --------------------------------------------------------------------------------

export function useLogStreams(ws: string, enabled = true) {
  return useQuery({
    queryKey: qk.logStreams(ws),
    queryFn: () => api.get<{ default: LogStream | null; overrides: LogStream[] }>(`/workspaces/${ws}/log-streams`),
    enabled,
  });
}

export function useSaveLogStream(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LogStreamInput) => api.put<LogStream>(`/workspaces/${ws}/log-stream`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.logStreams(ws) }),
  });
}

export function useDeleteLogStream(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/workspaces/${ws}/log-stream`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.logStreams(ws) }),
  });
}

// Metrics stream (OpenTelemetry) -------------------------------------------------------------

export interface MetricsStreamInput {
  endpoint: string;
  /** Omit to keep the stored headers. */
  headers?: Record<string, string>;
  enabled: boolean;
}

export function useMetricsStream(ws: string, enabled = true) {
  return useQuery({
    queryKey: qk.metricsStream(ws),
    queryFn: () => api.get<{ stream: MetricsStream | null }>(`/workspaces/${ws}/metrics-stream`),
    enabled,
  });
}

export function useSaveMetricsStream(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MetricsStreamInput) => api.put<{ stream: MetricsStream }>(`/workspaces/${ws}/metrics-stream`, body),
    onSuccess: (data) => qc.setQueryData(qk.metricsStream(ws), data),
  });
}

export function useDeleteMetricsStream(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/workspaces/${ws}/metrics-stream`),
    onSuccess: () => qc.setQueryData(qk.metricsStream(ws), { stream: null }),
  });
}

export function useTestMetricsStream(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ stream: MetricsStream }>(`/workspaces/${ws}/metrics-stream/test`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.metricsStream(ws) }),
  });
}

// Registry credentials -----------------------------------------------------------------------

export interface RegistryCredentialInput {
  name: string;
  registry: string;
  username: string;
  password: string;
}

export function useRegistryCredentials(ws: string, enabled = true) {
  return useQuery({
    queryKey: qk.registryCredentials(ws),
    queryFn: () => api.get<{ items: RegistryCredential[] }>(`/workspaces/${ws}/registry-credentials`),
    enabled,
  });
}

export function useCreateRegistryCredential(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegistryCredentialInput) => api.post<RegistryCredential>(`/workspaces/${ws}/registry-credentials`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.registryCredentials(ws) }),
  });
}

export function useUpdateRegistryCredential(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<RegistryCredentialInput> & { id: string }) => api.patch<RegistryCredential>(`/registry-credentials/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.registryCredentials(ws) }),
  });
}

export function useDeleteRegistryCredential(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/registry-credentials/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.registryCredentials(ws) }),
  });
}

// Audit log ----------------------------------------------------------------------------------

export function useAuditLogs(ws: string, filters: { action?: string; actor?: string }, limit = 50) {
  return useInfiniteQuery({
    queryKey: qk.auditLogs(ws, filters),
    queryFn: ({ pageParam }) =>
      api.get<{ items: AuditLogEntry[]; nextBefore: number | null }>(`/workspaces/${ws}/audit-logs`, {
        before: pageParam,
        limit,
        action: filters.action,
        actor: filters.actor,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
}
