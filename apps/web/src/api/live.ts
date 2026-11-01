import { useQueryClient } from '@tanstack/react-query';
import { buildUrl } from './client';
import { qk } from './keys';
import { useEventStream, type StreamState } from './sse';
import type { WorkspaceChange } from './types';

function isChange(v: unknown): v is WorkspaceChange {
  return typeof v === 'object' && v !== null && 'entity' in v && 'id' in v;
}

/**
 * One SSE subscription per workspace. Each `change` event invalidates exactly the queries
 * that can be affected, so status pills, deploy lists and instance tables update live.
 */
export function useWorkspaceLiveUpdates(ws: string | undefined): StreamState {
  const qc = useQueryClient();
  return useEventStream(ws ? `ws:${ws}` : null, {
    url: () => buildUrl(`/workspaces/${ws}/stream`),
    events: {
      change: (data) => {
        if (!ws || !isChange(data)) return;
        const { entity, id } = data;
        const serviceId = data.serviceId ?? undefined;
        const inv = (queryKey: readonly unknown[], exact = false) => qc.invalidateQueries({ queryKey, exact });
        switch (entity) {
          case 'service':
            inv(qk.services(ws));
            inv(qk.service(id), true);
            inv(qk.serviceEvents(id));
            inv(qk.servicePreviews(id));
            if (serviceId && serviceId !== id) inv(qk.servicePreviews(serviceId));
            break;
          case 'deploy':
            inv(qk.deploy(id), true);
            inv(qk.services(ws));
            if (serviceId) {
              inv(qk.serviceDeploys(serviceId));
              inv(qk.service(serviceId), true);
              inv(qk.serviceEvents(serviceId));
            }
            inv(qk.wsEvents(ws));
            break;
          case 'instance':
            if (serviceId) {
              inv(qk.serviceInstances(serviceId));
              inv(qk.service(serviceId), true);
            }
            break;
          case 'database':
            inv(qk.databases(ws));
            inv(qk.database(id), true);
            inv(qk.databaseBackups(id));
            break;
          case 'run':
            if (serviceId) inv(qk.serviceRuns(serviceId));
            break;
          case 'workflow_run':
            inv(qk.workflowRun(id));
            if (serviceId) {
              inv(qk.workflow(serviceId));
              inv(qk.workflowRuns(serviceId));
            }
            break;
          case 'blueprint':
            inv(qk.blueprints(ws));
            inv(qk.blueprint(id));
            break;
          case 'custom_domain':
          case 'domain':
            if (serviceId) inv(qk.serviceDomains(serviceId));
            break;
          case 'env_group':
            inv(qk.envGroups(ws));
            inv(qk.envGroup(id));
            break;
          default:
            if (serviceId) inv(qk.service(serviceId));
            inv(qk.services(ws));
        }
      },
    },
  });
}
