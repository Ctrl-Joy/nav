// SCIM 2.0 (RFC 7643/7644) helpers: the subset Okta and Microsoft Entra use for user and group provisioning.
// Pure functions only (filters, PATCH operations, resource shapes); routes/scim.ts does the storage.

export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const SCHEMA_RESOURCE_TYPE = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
export const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

export class ScimError extends Error {
  status: number;
  scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

export function errorBody(err: ScimError) {
  return { schemas: [SCHEMA_ERROR], status: String(err.status), ...(err.scimType ? { scimType: err.scimType } : {}), detail: err.message };
}

/** SCIM booleans arrive as true/false or, from Entra, as the strings "True"/"False". */
export function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw new ScimError(400, 'expected a boolean', 'invalidValue');
}

const str = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ScimError(400, `${what} must be a string`, 'invalidValue');
  return v.trim() || null;
};

/** Only `<attr> eq "<value>"` is supported: it is what IdPs send to look up a resource before creating it. */
export function parseFilter(filter: string | undefined, allowed: string[]): { attr: string; value: string } | null {
  if (!filter?.trim()) return null;
  const m = /^\s*([\w.:]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, 'only filters of the form `attribute eq "value"` are supported', 'invalidFilter');
  const attr = allowed.find((a) => a.toLowerCase() === m[1].toLowerCase());
  if (!attr) throw new ScimError(400, `filtering on ${m[1]} is not supported`, 'invalidFilter');
  return { attr, value: m[2].replace(/\\(.)/g, '$1') };
}

export interface UserState {
  userName: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  email: string | null;
  active: boolean;
}

type Emails = { value?: unknown; primary?: unknown; type?: unknown }[];

function primaryEmail(emails: unknown): string | null {
  if (!Array.isArray(emails) || !emails.length) return null;
  const list = emails as Emails;
  const pick = list.find((e) => e.primary === true || e.primary === 'true') ?? list.find((e) => e.type === 'work') ?? list[0];
  return str(pick?.value, 'emails.value')?.toLowerCase() ?? null;
}

/** Full representation from POST / PUT. */
export function userFromResource(body: unknown): UserState {
  if (!body || typeof body !== 'object') throw new ScimError(400, 'a User resource is required', 'invalidSyntax');
  const b = body as Record<string, any>;
  const userName = str(b.userName, 'userName');
  if (!userName) throw new ScimError(400, 'userName is required', 'invalidValue');
  return {
    userName,
    externalId: str(b.externalId, 'externalId'),
    givenName: str(b.name?.givenName, 'name.givenName'),
    familyName: str(b.name?.familyName, 'name.familyName'),
    displayName: str(b.displayName, 'displayName') ?? str(b.name?.formatted, 'name.formatted'),
    email: primaryEmail(b.emails),
    active: b.active === undefined ? true : bool(b.active),
  };
}

function setUserAttr(s: UserState, path: string, value: unknown, remove: boolean): void {
  const p = path.trim();
  const lower = p.toLowerCase();
  const v = remove ? null : value;
  if (lower === 'active') s.active = remove ? false : bool(v);
  else if (lower === 'username') {
    const u = str(v, 'userName');
    if (!u) throw new ScimError(400, 'userName cannot be removed', 'mutability');
    s.userName = u;
  } else if (lower === 'externalid') s.externalId = str(v, 'externalId');
  else if (lower === 'displayname') s.displayName = str(v, 'displayName');
  else if (lower === 'name.givenname') s.givenName = str(v, 'name.givenName');
  else if (lower === 'name.familyname') s.familyName = str(v, 'name.familyName');
  else if (lower === 'name.formatted') s.displayName = str(v, 'name.formatted') ?? s.displayName;
  else if (lower === 'name') {
    const n = (v ?? {}) as Record<string, unknown>;
    if ('givenName' in n || remove) s.givenName = str(n.givenName, 'name.givenName');
    if ('familyName' in n || remove) s.familyName = str(n.familyName, 'name.familyName');
  } else if (lower === 'emails') s.email = remove ? null : primaryEmail(v);
  else if (/^emails(\[[^\]]*\])?\.value$/.test(lower)) s.email = str(v, 'emails.value')?.toLowerCase() ?? null;
  // Anything else (enterprise extension, phone numbers, ...) is accepted and ignored.
}

/** Applies PATCH operations (RFC 7644 §3.5.2) to a user. Handles both Okta's and Entra's styles. */
export function applyUserPatch(current: UserState, body: unknown): UserState {
  const ops = patchOps(body);
  const s = { ...current };
  for (const op of ops) {
    const kind = String(op.op ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw new ScimError(400, `unsupported op ${op.op}`, 'invalidSyntax');
    if (op.path) setUserAttr(s, String(op.path), op.value, kind === 'remove');
    else {
      if (kind === 'remove' || !op.value || typeof op.value !== 'object') throw new ScimError(400, 'an operation without a path needs an object value', 'noTarget');
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
        if (k === 'name' && v && typeof v === 'object') for (const [nk, nv] of Object.entries(v)) setUserAttr(s, `name.${nk}`, nv, false);
        else setUserAttr(s, k, v, false);
      }
    }
  }
  return s;
}

interface PatchOp { op?: unknown; path?: unknown; value?: unknown }

function patchOps(body: unknown): PatchOp[] {
  const b = body as { schemas?: unknown; Operations?: unknown } | null;
  if (!b || !Array.isArray(b.Operations)) throw new ScimError(400, 'a PatchOp with Operations is required', 'invalidSyntax');
  return b.Operations as PatchOp[];
}

function memberIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((m) => {
    const id = typeof m === 'string' ? m : (m as { value?: unknown })?.value;
    if (typeof id !== 'string' || !id) throw new ScimError(400, 'members need a value', 'invalidValue');
    return id;
  });
}

export interface GroupPatch {
  displayName?: string;
  externalId?: string | null;
  add: string[];
  remove: string[];
  /** Set when the operation replaces the whole member list. */
  replace?: string[];
}

/** PATCH on a Group: rename and member add/remove/replace, including the `members[value eq "id"]` path form. */
export function parseGroupPatch(body: unknown): GroupPatch {
  const out: GroupPatch = { add: [], remove: [] };
  for (const op of patchOps(body)) {
    const kind = String(op.op ?? '').toLowerCase();
    const path = typeof op.path === 'string' ? op.path.trim() : '';
    const filtered = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (kind === 'remove') {
      if (filtered) out.remove.push(filtered[1]);
      else if (path.toLowerCase() === 'members') {
        if (op.value === undefined) out.replace = [];
        else out.remove.push(...memberIds(op.value));
      } else throw new ScimError(400, `cannot remove ${path || 'the group'}`, 'noTarget');
    } else if (kind === 'add' || kind === 'replace') {
      if (path.toLowerCase() === 'members') {
        if (kind === 'replace') out.replace = memberIds(op.value);
        else out.add.push(...memberIds(op.value));
      } else if (path.toLowerCase() === 'displayname') out.displayName = str(op.value, 'displayName') ?? undefined;
      else if (path.toLowerCase() === 'externalid') out.externalId = str(op.value, 'externalId');
      else if (!path && op.value && typeof op.value === 'object') {
        const v = op.value as Record<string, unknown>;
        if (typeof v.displayName === 'string') out.displayName = v.displayName.trim();
        if ('externalId' in v) out.externalId = str(v.externalId, 'externalId');
        if ('members' in v) {
          if (kind === 'replace') out.replace = memberIds(v.members);
          else out.add.push(...memberIds(v.members));
        }
      } else if (path) {
        /* other attributes are ignored */
      } else throw new ScimError(400, 'an operation without a path needs an object value', 'noTarget');
    } else throw new ScimError(400, `unsupported op ${op.op}`, 'invalidSyntax');
  }
  return out;
}

export function listResponse<T>(resources: T[], total: number, startIndex: number) {
  return { schemas: [SCHEMA_LIST], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}

/** startIndex is 1-based; count is capped. */
export function paging(q: { startIndex?: string; count?: string }): { offset: number; limit: number; startIndex: number } {
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? '1', 10) || 1);
  const count = Number.parseInt(q.count ?? '100', 10);
  const limit = Math.min(Math.max(Number.isFinite(count) ? count : 100, 0), 200);
  return { offset: startIndex - 1, limit, startIndex };
}

export function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: [SCHEMA_SPC],
    documentationUri: `${baseUrl.replace(/\/scim\/v2.*$/, '')}/docs`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Authentication with the organization SCIM token', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    { schemas: [SCHEMA_RESOURCE_TYPE], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA_USER, meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User` } },
    { schemas: [SCHEMA_RESOURCE_TYPE], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA_GROUP, meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/Group` } },
  ];
}

const attr = (name: string, extra: Record<string, unknown> = {}) => ({
  name, type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra,
});

export function schemas(baseUrl: string) {
  return [
    {
      schemas: [SCHEMA_SCHEMA], id: SCHEMA_USER, name: 'User', description: 'User account',
      attributes: [
        attr('userName', { required: true, uniqueness: 'server' }),
        attr('externalId'),
        attr('displayName'),
        { ...attr('name', { type: 'complex' }), subAttributes: [attr('givenName'), attr('familyName'), attr('formatted')] },
        { ...attr('emails', { type: 'complex', multiValued: true }), subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })] },
        attr('active', { type: 'boolean' }),
        { ...attr('groups', { type: 'complex', multiValued: true, mutability: 'readOnly' }), subAttributes: [attr('value', { mutability: 'readOnly' }), attr('display', { mutability: 'readOnly' })] },
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCHEMA_USER}` },
    },
    {
      schemas: [SCHEMA_SCHEMA], id: SCHEMA_GROUP, name: 'Group', description: 'Group (can be mapped to a workspace role)',
      attributes: [
        attr('displayName', { required: true, uniqueness: 'server' }),
        attr('externalId'),
        { ...attr('members', { type: 'complex', multiValued: true }), subAttributes: [attr('value', { mutability: 'immutable' }), attr('display', { mutability: 'readOnly' })] },
      ],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCHEMA_GROUP}` },
    },
  ];
}
