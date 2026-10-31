import type { ListFilters } from './types';

export type MetricsRange = '1h' | '6h' | '24h' | '7d';

/** Central query-key factory. Hierarchical so invalidations can target a resource and its children. */
export const qk = {
  me: ['me'] as const,
  config: ['config'] as const,
  apiKeys: ['api-keys'] as const,
  workspaces: ['workspaces'] as const,
  branches: (repoUrl: string) => ['git', 'branches', repoUrl] as const,

  ws: (ws: string) => ['ws', ws] as const,
  services: (ws: string, f?: ListFilters) => (f ? (['ws', ws, 'services', f] as const) : (['ws', ws, 'services'] as const)),
  databases: (ws: string) => ['ws', ws, 'databases'] as const,
  envGroups: (ws: string) => ['ws', ws, 'env-groups'] as const,
  blueprints: (ws: string) => ['ws', ws, 'blueprints'] as const,
  projects: (ws: string) => ['ws', ws, 'projects'] as const,
  members: (ws: string) => ['ws', ws, 'members'] as const,
  wsEvents: (ws: string) => ['ws', ws, 'events'] as const,
  notifications: (ws: string) => ['ws', ws, 'notifications'] as const,
  repos: (ws: string) => ['ws', ws, 'repos'] as const,

  service: (id: string) => ['service', id] as const,
  serviceDeploys: (id: string) => ['service', id, 'deploys'] as const,
  serviceInstances: (id: string) => ['service', id, 'instances'] as const,
  serviceEvents: (id: string) => ['service', id, 'events'] as const,
  serviceEnvVars: (id: string) => ['service', id, 'env-vars'] as const,
  serviceSecretFiles: (id: string) => ['service', id, 'secret-files'] as const,
  serviceDomains: (id: string) => ['service', id, 'domains'] as const,
  servicePreviews: (id: string) => ['service', id, 'previews'] as const,
  serviceRuns: (id: string) => ['service', id, 'runs'] as const,
  serviceMetrics: (id: string, range: MetricsRange) => ['service', id, 'metrics', range] as const,

  deploy: (id: string) => ['deploy', id] as const,
  run: (id: string) => ['run', id] as const,
  runLogs: (id: string) => ['run', id, 'logs'] as const,

  database: (id: string) => ['database', id] as const,
  databaseCredentials: (id: string) => ['database', id, 'credentials'] as const,
  databaseBackups: (id: string) => ['database', id, 'backups'] as const,
  databaseMetrics: (id: string, range: MetricsRange) => ['database', id, 'metrics', range] as const,

  envGroup: (id: string) => ['env-group', id] as const,
  blueprint: (id: string) => ['blueprint', id] as const,
};
