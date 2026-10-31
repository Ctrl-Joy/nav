import type { Database, Service } from '@nav/shared';
import { ApiClient, listAll } from './api.ts';
import { resolveConfig, type ResolvedConfig } from './config.ts';
import { CliError, UsageError } from './errors.ts';

export interface AuthContext {
  config: ResolvedConfig;
  client: ApiClient;
}

export interface WorkspaceContext extends AuthContext {
  workspaceId: string;
}

export async function authContext(): Promise<AuthContext> {
  const config = await resolveConfig();
  if (!config.token) throw new CliError('not logged in', 'run nav login, or set NAV_TOKEN');
  return { config, client: new ApiClient({ host: config.host, token: config.token }) };
}

export async function workspaceContext(): Promise<WorkspaceContext> {
  const base = await authContext();
  const workspaceId = base.config.workspaceId;
  if (!workspaceId) {
    throw new CliError('no workspace selected', 'run nav workspaces, then nav workspace use <id|slug>');
  }
  return { ...base, workspaceId };
}

export interface Named {
  id: string;
  name: string;
  slug?: string;
}

// Matches by id first, then by name or slug (case-insensitive). Ambiguous names are rejected.
export function matchByRef<T extends Named>(items: T[], ref: string, label: string, hint: string): T {
  const byId = items.find((item) => item.id === ref);
  if (byId) return byId;
  const wanted = ref.toLowerCase();
  const matches = items.filter(
    (item) => item.name.toLowerCase() === wanted || (item.slug ?? '').toLowerCase() === wanted,
  );
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) {
    throw new UsageError(
      `${label} "${ref}" is ambiguous; use one of these ids: ${matches.map((m) => m.id).join(', ')}`,
    );
  }
  throw new CliError(`${label} "${ref}" not found`, hint);
}

export async function findService(ctx: WorkspaceContext, ref: string): Promise<Service> {
  const services = await listAll<Service>(ctx.client, `/workspaces/${ctx.workspaceId}/services`);
  return matchByRef(services, ref, 'service', 'run nav services to list services in this workspace');
}

export async function findDatabase(ctx: WorkspaceContext, ref: string): Promise<Database> {
  const databases = await listAll<Database>(ctx.client, `/workspaces/${ctx.workspaceId}/databases`);
  return matchByRef(databases, ref, 'database', 'run nav db list to list databases in this workspace');
}
