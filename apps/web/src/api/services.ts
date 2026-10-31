import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateServiceInput,
  CustomDomain,
  Deploy,
  EnvVar,
  Event as NavEvent,
  Instance,
  LogLine,
  MetricsResponse,
  Page,
  Run,
  SecretFile,
  Service,
  UpdateServiceInput,
} from '@nav/shared';
import { DEPLOY_ACTIVE } from '@nav/shared';
import { api } from './client';
import { qk, type MetricsRange } from './keys';
import type { CreateServiceResponse, ListFilters } from './types';

// Services -----------------------------------------------------------------------------------

export function useServices(ws: string, filters: ListFilters = {}) {
  return useQuery({
    queryKey: qk.services(ws, filters),
    queryFn: () =>
      api.get<Page<Service>>(`/workspaces/${ws}/services`, {
        type: filters.type,
        environmentId: filters.environmentId,
        q: filters.q,
        includePreviews: filters.includePreviews ? 1 : undefined,
        limit: 200,
      }),
    placeholderData: keepPreviousData,
  });
}

export function useService(id: string | undefined) {
  return useQuery({
    queryKey: qk.service(id ?? ''),
    queryFn: () => api.get<Service>(`/services/${id}`),
    enabled: !!id,
  });
}

function useInvalidateService() {
  const qc = useQueryClient();
  return (s: Pick<Service, 'id' | 'workspaceId'>) => {
    qc.invalidateQueries({ queryKey: qk.service(s.id), exact: true });
    qc.invalidateQueries({ queryKey: qk.services(s.workspaceId) });
    qc.invalidateQueries({ queryKey: qk.serviceEvents(s.id) });
  };
}

export function useCreateService(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateServiceInput) => api.post<CreateServiceResponse>(`/workspaces/${ws}/services`, input),
    onSuccess: (data) => {
      qc.setQueryData(qk.service(data.service.id), data.service);
      qc.invalidateQueries({ queryKey: qk.services(ws) });
    },
  });
}

export function useUpdateService(service: Pick<Service, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  const inv = useInvalidateService();
  return useMutation({
    mutationFn: (input: UpdateServiceInput) => api.patch<Service>(`/services/${service.id}`, input),
    onSuccess: (data) => {
      qc.setQueryData(qk.service(service.id), data);
      inv(service);
    },
  });
}

export function useDeleteService(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/services/${id}`),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.service(id) });
      qc.invalidateQueries({ queryKey: qk.services(ws) });
    },
  });
}

type ServiceAction = 'suspend' | 'resume' | 'restart';

export function useServiceAction(service: Pick<Service, 'id' | 'workspaceId'>) {
  const inv = useInvalidateService();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: ServiceAction) => api.post<unknown>(`/services/${service.id}/${action}`),
    onSuccess: () => {
      inv(service);
      qc.invalidateQueries({ queryKey: qk.serviceDeploys(service.id) });
      qc.invalidateQueries({ queryKey: qk.serviceInstances(service.id) });
    },
  });
}

export function useScaleService(service: Pick<Service, 'id' | 'workspaceId'>) {
  const inv = useInvalidateService();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (instanceCount: number) => api.post<unknown>(`/services/${service.id}/scale`, { instanceCount }),
    onSuccess: () => {
      inv(service);
      qc.invalidateQueries({ queryKey: qk.serviceInstances(service.id) });
    },
  });
}

export function useInstances(serviceId: string, live = true) {
  return useQuery({
    queryKey: qk.serviceInstances(serviceId),
    queryFn: () => api.get<Page<Instance>>(`/services/${serviceId}/instances`),
    refetchInterval: live ? 15_000 : false,
  });
}

export function useRotateDeployHook(service: Pick<Service, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ deployHookUrl: string }>(`/services/${service.id}/deploy-hook/rotate`),
    onSuccess: (data) => {
      qc.setQueryData<Service>(qk.service(service.id), (old) => (old ? { ...old, deployHookUrl: data.deployHookUrl } : old));
    },
  });
}

// Previews -------------------------------------------------------------------------------------

export function usePreviews(serviceId: string) {
  return useQuery({
    queryKey: qk.servicePreviews(serviceId),
    queryFn: () => api.get<Page<Service>>(`/services/${serviceId}/previews`),
  });
}

export function useCreatePreview(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { branch: string; prNumber?: number }) => api.post<CreateServiceResponse>(`/services/${serviceId}/previews`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.servicePreviews(serviceId) }),
  });
}

// Deploys --------------------------------------------------------------------------------------

export function useDeploys(serviceId: string, limit = 25) {
  return useInfiniteQuery({
    queryKey: qk.serviceDeploys(serviceId),
    queryFn: ({ pageParam }) => api.get<Page<Deploy>>(`/services/${serviceId}/deploys`, { cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useDeploy(id: string | undefined) {
  return useQuery({
    queryKey: qk.deploy(id ?? ''),
    queryFn: () => api.get<Deploy>(`/deploys/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && DEPLOY_ACTIVE.includes(q.state.data.status) ? 5_000 : false),
  });
}

function useInvalidateDeploys(serviceId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: qk.serviceDeploys(serviceId) });
    qc.invalidateQueries({ queryKey: qk.service(serviceId), exact: true });
    qc.invalidateQueries({ queryKey: qk.serviceEvents(serviceId) });
  };
}

export function useTriggerDeploy(serviceId: string) {
  const inv = useInvalidateDeploys(serviceId);
  return useMutation({
    mutationFn: (body: { clearCache?: boolean; commitSha?: string }) => api.post<Deploy>(`/services/${serviceId}/deploys`, body),
    onSuccess: inv,
  });
}

export function useCancelDeploy(serviceId: string) {
  const inv = useInvalidateDeploys(serviceId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deployId: string) => api.post<unknown>(`/deploys/${deployId}/cancel`),
    onSuccess: (_d, deployId) => {
      inv();
      qc.invalidateQueries({ queryKey: qk.deploy(deployId) });
    },
  });
}

export function useRollback(serviceId: string) {
  const inv = useInvalidateDeploys(serviceId);
  return useMutation({
    mutationFn: (deployId: string) => api.post<Deploy>(`/deploys/${deployId}/rollback`),
    onSuccess: inv,
  });
}

export function useServiceEvents(serviceId: string, limit = 50) {
  return useInfiniteQuery({
    queryKey: qk.serviceEvents(serviceId),
    queryFn: ({ pageParam }) => api.get<Page<NavEvent>>(`/services/${serviceId}/events`, { cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

// Environment ----------------------------------------------------------------------------------

export function useEnvVars(serviceId: string) {
  return useQuery({
    queryKey: qk.serviceEnvVars(serviceId),
    queryFn: () => api.get<{ items: EnvVar[] }>(`/services/${serviceId}/env-vars`),
    refetchOnWindowFocus: false,
  });
}

export function useReplaceEnvVars(service: Pick<Service, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  const inv = useInvalidateDeploys(service.id);
  return useMutation({
    mutationFn: (body: { envVars: EnvVar[]; deploy: boolean }) => api.put<unknown>(`/services/${service.id}/env-vars`, body),
    onSuccess: (_d, body) => {
      qc.setQueryData(qk.serviceEnvVars(service.id), { items: body.envVars });
      qc.invalidateQueries({ queryKey: qk.serviceEnvVars(service.id) });
      inv();
    },
  });
}

export function useSecretFiles(serviceId: string) {
  return useQuery({
    queryKey: qk.serviceSecretFiles(serviceId),
    queryFn: () => api.get<{ items: SecretFile[] }>(`/services/${serviceId}/secret-files`),
    refetchOnWindowFocus: false,
  });
}

export function useReplaceSecretFiles(service: Pick<Service, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  const inv = useInvalidateDeploys(service.id);
  return useMutation({
    mutationFn: (body: { secretFiles: SecretFile[]; deploy: boolean }) => api.put<unknown>(`/services/${service.id}/secret-files`, body),
    onSuccess: (_d, body) => {
      qc.setQueryData(qk.serviceSecretFiles(service.id), { items: body.secretFiles });
      inv();
    },
  });
}

export function useLinkEnvGroups(service: Pick<Service, 'id' | 'workspaceId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupIds: string[]) => api.put<unknown>(`/services/${service.id}/env-groups`, { groupIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.envGroups(service.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.serviceDeploys(service.id) });
    },
  });
}

// Logs, metrics, runs ----------------------------------------------------------------------------

export interface LogQuery {
  stream?: string;
  deployId?: string;
  instanceId?: string;
  runId?: string;
  q?: string;
  level?: string;
  before?: number;
  after?: number;
  since?: string;
  until?: string;
  limit?: number;
}

export function fetchServiceLogs(serviceId: string, query: LogQuery, signal?: AbortSignal) {
  return api.get<{ items: LogLine[] }>(`/services/${serviceId}/logs`, { ...query }, signal);
}

export function useServiceMetrics(serviceId: string, range: MetricsRange) {
  return useQuery({
    queryKey: qk.serviceMetrics(serviceId, range),
    queryFn: () => api.get<MetricsResponse>(`/services/${serviceId}/metrics`, { range }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useRuns(serviceId: string, limit = 50) {
  return useInfiniteQuery({
    queryKey: qk.serviceRuns(serviceId),
    queryFn: ({ pageParam }) => api.get<Page<Run>>(`/services/${serviceId}/runs`, { cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some((r) => r.status === 'pending' || r.status === 'running')) ? 5_000 : false,
  });
}

export function useCreateRun(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { command?: string }) => api.post<Run>(`/services/${serviceId}/runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.serviceRuns(serviceId) }),
  });
}

export function useCancelRun(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post<unknown>(`/runs/${runId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.serviceRuns(serviceId) }),
  });
}

export function useRunLogs(runId: string | null, live: boolean) {
  return useQuery({
    queryKey: qk.runLogs(runId ?? ''),
    queryFn: () => api.get<{ items: LogLine[] }>(`/runs/${runId}/logs`),
    enabled: !!runId,
    refetchInterval: live ? 3_000 : false,
  });
}

// Custom domains -----------------------------------------------------------------------------------

export function useCustomDomains(serviceId: string) {
  return useQuery({
    queryKey: qk.serviceDomains(serviceId),
    queryFn: () => api.get<{ items: CustomDomain[] }>(`/services/${serviceId}/custom-domains`),
    refetchInterval: (q) =>
      q.state.data?.items.some((d) => d.certStatus === 'issuing' || d.certStatus === 'pending') ? 10_000 : false,
  });
}

export function useAddDomain(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => api.post<CustomDomain | { items: CustomDomain[] }>(`/services/${serviceId}/custom-domains`, { domain }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.serviceDomains(serviceId) }),
  });
}

export function useVerifyDomain(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => api.post<CustomDomain>(`/custom-domains/${domainId}/verify`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.serviceDomains(serviceId) }),
  });
}

export function useDeleteDomain(serviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => api.del(`/custom-domains/${domainId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.serviceDomains(serviceId) }),
  });
}
