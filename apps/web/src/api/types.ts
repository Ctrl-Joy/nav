// Response shapes documented in docs/API.md that are not exported by @nav/shared.
import type { ApiKey, Deploy, Member, Service, User, Workspace } from '@nav/shared';

export interface AppConfig {
  githubEnabled: boolean;
  githubAppSlug: string | null;
  appsDomain: string;
  edgeHttpPort: number | null;
  driver: string;
  version: string;
  auth?: { providers: Partial<Record<AuthProvider, boolean>> };
}

export type AuthProvider = 'github' | 'gitlab' | 'bitbucket' | 'google' | 'sso';

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface IdentityInfo {
  provider: AuthProvider;
  email: string | null;
  username: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MeResponse {
  user: User;
  workspaces: Workspace[];
}

export interface CreateApiKeyResponse {
  apiKey: ApiKey;
  token: string;
}

export interface CreateServiceResponse {
  service: Service;
  deploy: Deploy;
}

export interface AddMemberResponse {
  member?: Member;
  invite?: { id: string; token: string };
}

export type Series = [string, number][];

export interface DbMetricsResponse {
  cpu: Series;
  memoryMB: Series;
  connections: Series;
  sizeBytes: Series;
}

/** `POST /databases/:id/query` — columns may be plain names or `{name}` objects; rows arrays or records. */
export interface QueryResult {
  columns: (string | { name: string; dataTypeID?: number; type?: string })[];
  rows: (unknown[] | Record<string, unknown>)[];
  rowCount: number | null;
  durationMs: number;
  command?: string;
}

export type PlanItem = string | { type?: string; name?: string; kind?: string; id?: string; changes?: unknown };

export interface BlueprintValidateResult {
  valid: boolean;
  errors: (string | { path?: string; message: string })[];
  plan: { create: PlanItem[]; update: PlanItem[]; unchanged: PlanItem[] };
}

export interface NotificationSettings {
  webhookUrl: string | null;
  /** Assumed: 'all' | 'failure' | 'none'. */
  notifyOn: string;
}

export type WorkspaceChangeEntity = 'service' | 'deploy' | 'database' | 'instance' | (string & {});

export interface WorkspaceChange {
  entity: WorkspaceChangeEntity;
  id: string;
  serviceId?: string | null;
}

export interface ListFilters {
  type?: string;
  environmentId?: string;
  q?: string;
  includePreviews?: boolean;
}
