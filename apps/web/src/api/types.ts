// Response shapes documented in docs/API.md that are not exported by @nav/shared.
import type { ApiKey, Deploy, Member, Service, User, Workspace } from '@nav/shared';

/** `/auth/me` user, with the account-security fields not (yet) in @nav/shared. */
export interface MeUser extends User {
  mfaEnabled?: boolean;
  recoveryCodesLeft?: number;
  emailNotifications?: boolean;
  /** Administers this NAV instance (NAV_ADMIN_EMAILS, or the first account): may manage sign-in providers. */
  isPlatformAdmin?: boolean;
}

/** Workspace list item, including its login policy and the org that owns it (null for personal workspaces). */
export interface WorkspaceInfo extends Workspace {
  requireTwoFactor?: boolean;
  orgId?: string | null;
  orgName?: string | null;
}

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  requireTwoFactor: boolean;
  createdAt: string;
}

export interface OrgDetail extends OrgInfo {
  defaultWorkspaceId: string | null;
  defaultRole: 'admin' | 'developer' | 'viewer';
}

export interface OrgMember {
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  mfaEnabled: boolean;
  scimManaged: boolean;
  samlLinked: boolean;
  createdAt: string;
}

export interface OrgWorkspace {
  id: string;
  name: string;
  slug: string;
  members: number;
  services: number;
  databases: number;
  requireTwoFactor: boolean;
  createdAt: string;
}

export interface OrgDomain {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  txtName: string;
  txtValue: string;
  createdAt: string;
}

export interface SamlSettings {
  enabled: boolean;
  enforce: boolean;
  configured: boolean;
  sp: { entityId: string; acsUrl: string; metadataUrl: string; loginUrl: string; certificate: string };
  idp: {
    entityId: string | null;
    ssoUrl: string | null;
    binding: 'redirect' | 'post';
    certificates: { subject: string; notAfter: string | null; fingerprint256: string | null }[];
  };
  updatedAt: string;
}

export interface SamlUpdate {
  metadataXml?: string;
  entityId?: string;
  ssoUrl?: string;
  certificate?: string;
  binding?: 'redirect' | 'post';
  enabled: boolean;
  enforce: boolean;
}

export interface ScimSettings {
  baseUrl: string;
  tokens: { id: string; name: string; prefix: string; createdByEmail: string | null; createdAt: string; lastUsedAt: string | null }[];
  groups: { id: string; displayName: string; members: number; workspaceId: string | null; workspaceName: string | null; role: 'admin' | 'developer' | 'viewer' | null; updatedAt: string }[];
  users: { total: number; active: number };
}

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
  user: MeUser;
  workspaces: WorkspaceInfo[];
  /** Organizations the user belongs to (only on GET /auth/me). */
  orgs?: OrgInfo[];
}

/** Password / OAuth sign-in for an account with 2FA: a code is still needed (POST /auth/login/mfa). */
export interface MfaChallenge {
  mfaRequired: true;
}

export function isMfaChallenge(v: unknown): v is MfaChallenge {
  return typeof v === 'object' && v !== null && (v as MfaChallenge).mfaRequired === true;
}

export interface MfaLoginResponse {
  ok: true;
  next: string;
  usedRecoveryCode: boolean;
  recoveryCodesLeft?: number;
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
  /** 'all' | 'failure' | 'none'. */
  notifyOn: string;
  /** Emails to members who opted in (account settings): 'all' | 'failure' | 'none'. */
  emailNotifyOn?: string;
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

// Integrations ---------------------------------------------------------------------------------

export interface OutboundWebhook {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  /** Subscribed event types; empty = every event. */
  events: string[];
  enabled: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: number;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  payload: unknown;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export type LogStreamProtocol = 'syslog-tls' | 'syslog-tcp' | 'https';

export interface LogStream {
  id: string;
  serviceId: string | null;
  protocol: LogStreamProtocol;
  endpoint: string;
  hasToken: boolean;
  enabled: boolean;
  lastError: string | null;
  lastSentAt: string | null;
}

export interface LogStreamInput {
  protocol: LogStreamProtocol;
  endpoint: string;
  /** Omit to keep the stored token, null to remove it. */
  token?: string | null;
  enabled: boolean;
}

export interface MetricsStream {
  endpoint: string;
  headerNames: string[];
  enabled: boolean;
  lastError: string | null;
  lastSentAt: string | null;
}

export interface RegistryCredential {
  id: string;
  workspaceId: string;
  name: string;
  registry: string;
  username: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorKind: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  data: { method?: string; path?: string; fields?: string[]; [k: string]: unknown } | null;
  createdAt: string;
  /** Org-wide log only: the workspace an entry belongs to. */
  workspaceId?: string | null;
  workspaceName?: string | null;
}

export interface DiskSnapshot {
  id: string;
  serviceId: string;
  kind: 'automatic' | 'manual';
  status: 'pending' | 'completed' | 'failed' | 'restoring';
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// Key Value --------------------------------------------------------------------------------------

export interface KeyValue {
  id: string;
  workspaceId: string;
  environmentId: string | null;
  name: string;
  slug: string;
  plan: string;
  maxmemoryPolicy: string;
  status: 'creating' | 'available' | 'suspended' | 'failed' | 'deleting';
  ipAllowList: { cidr: string; description: string }[];
  /** Password masked; reveal through GET /key-value/:id/credentials. */
  internalUrl: string | null;
  /** rediss:// through the node's TLS proxy; null while external access is off (or the proxy is starting). */
  externalUrl: string | null;
  /** Certificate the TLS endpoint serves: the platform wildcard, or the node's self-signed one. */
  externalTls: { certificate: 'platform' | 'self-signed'; fingerprint: string | null } | null;
  createdAt: string;
}

export interface KeyValueCredentials {
  password: string;
  internalUrl: string | null;
  externalUrl: string | null;
}
