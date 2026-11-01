import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { UsageReport } from '@nav/shared';
import { api } from './client';

const usageKey = (ws: string, month: string) => ['ws', ws, 'usage', month] as const;

export function useUsage(ws: string, month: string, enabled = true) {
  return useQuery({
    queryKey: usageKey(ws, month),
    queryFn: () => api.get<UsageReport>(`/workspaces/${ws}/usage`, { month }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** The same report as CSV (one row per resource and plan, plus a total). */
export function fetchUsageCsv(ws: string, month: string): Promise<string> {
  return api.get<string>(`/workspaces/${ws}/usage`, { month, format: 'csv' });
}
