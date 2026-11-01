// Audit log: every successful change made through the API, attributed to a person or API key, with the IP it
// came from. Recorded by one onResponse hook (see app.ts), so new routes are covered without extra code.
// Request bodies are reduced to their field names: values (env vars, passwords, keys) never reach the log.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, q } from '../../db/pool.ts';
import { workspaceRole } from '../auth.ts';

/** Route prefix -> table, to find which workspace a /<prefix>/:id route belongs to. */
const OWNERS: Record<string, string> = {
  services: 'services',
  databases: 'databases',
  'key-value': 'key_values',
  'env-groups': 'env_groups',
  blueprints: 'blueprints',
  projects: 'projects',
};
const SINGULAR: Record<string, string> = {
  services: 'service', databases: 'database', 'key-value': 'key_value', 'env-groups': 'env_group', blueprints: 'blueprint', projects: 'project',
  'custom-domains': 'custom_domain', deploys: 'deploy', runs: 'run', environments: 'environment', 'api-keys': 'api_key', members: 'member',
  invites: 'invite', backups: 'backup', 'env-vars': 'env_var', 'secret-files': 'secret_file', workspaces: 'workspace', webhooks: 'webhook', 'log-streams': 'log_stream', snapshots: 'snapshot',
};

/** "POST /services/:id/scale" -> service.scale; "PATCH /services/:id" -> service.update; "POST /workspaces/:ws/services" -> service.create. */
export function actionFor(method: string, pattern: string): { action: string; target: string | null } {
  const parts = pattern.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);
  const named = parts.filter((p) => !p.startsWith(':'));
  const last = parts[parts.length - 1];
  const verbs: Record<string, string> = { POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' };
  if (last && !last.startsWith(':') && parts.length >= 3 && parts[parts.length - 2].startsWith(':') && method === 'POST' && !SINGULAR[last]) {
    // An action on a resource: POST /services/:id/restart
    return { action: `${SINGULAR[named[named.length - 2]] ?? named[named.length - 2]}.${last.replace(/-/g, '_')}`, target: named[named.length - 2] };
  }
  const noun = named[named.length - 1] ?? 'resource';
  const kind = SINGULAR[noun] ?? noun.replace(/-/g, '_').replace(/s$/, '');
  const verb = last?.startsWith(':') ? verbs[method] ?? method.toLowerCase() : method === 'POST' ? 'create' : verbs[method] ?? method.toLowerCase();
  return { action: `${kind}.${verb}`, target: noun };
}

async function workspaceOf(req: FastifyRequest): Promise<string | null> {
  const params = (req.params ?? {}) as Record<string, string>;
  if (params.ws) return params.ws;
  const prefix = (req.routeOptions.url ?? '').replace(/^\/api\/v1\//, '').split('/')[0];
  const table = OWNERS[prefix];
  if (table && params.id) return (await one(`SELECT workspace_id FROM ${table} WHERE id = $1`, [params.id]).catch(() => null))?.workspace_id ?? null;
  const row = params.id
    ? await one(
        `SELECT s.workspace_id FROM deploys d JOIN services s ON s.id = d.service_id WHERE d.id = $1
         UNION ALL SELECT s.workspace_id FROM runs r JOIN services s ON s.id = r.service_id WHERE r.id = $1
         UNION ALL SELECT s.workspace_id FROM custom_domains c JOIN services s ON s.id = c.service_id WHERE c.id = $1 LIMIT 1`,
        [params.id],
      ).catch(() => null)
    : null;
  return row?.workspace_id ?? null;
}

export async function recordAudit(req: FastifyRequest): Promise<void> {
  const pattern = req.routeOptions.url ?? req.url;
  // Sign-in, sign-out and similar are about the person, not a workspace.
  if (/^\/api\/v1\/(auth|webhooks)\//.test(pattern)) return;
  const workspaceId = await workspaceOf(req);
  const { action, target } = actionFor(req.method, pattern);
  const params = (req.params ?? {}) as Record<string, string>;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body as object) : [];
  await q(
    `INSERT INTO audit_logs (workspace_id, actor_id, actor_email, actor_kind, action, target_type, target_id, ip, user_agent, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [workspaceId, req.user!.id, req.user!.email, req.authKind ?? 'session', action, target, params.id ?? params.userId ?? params.inviteId ?? null,
      req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), { method: req.method, path: req.url.split('?')[0], fields: body }],
  );
}

export async function auditRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/audit-logs', async (req) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'admin');
    const qs = z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), action: z.string().max(60).optional(), actor: z.string().max(254).optional() }).parse(req.query);
    const rows = await q(
      `SELECT * FROM audit_logs WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2) AND ($3::text IS NULL OR action LIKE $3 || '%')
         AND ($4::text IS NULL OR actor_email = $4) ORDER BY id DESC LIMIT $5`,
      [ws, qs.before ?? null, qs.action ?? null, qs.actor ?? null, qs.limit],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id), action: r.action, actorId: r.actor_id, actorEmail: r.actor_email, actorKind: r.actor_kind,
        targetType: r.target_type, targetId: r.target_id, ip: r.ip, userAgent: r.user_agent, data: r.data, createdAt: r.created_at,
      })),
      nextBefore: rows.length === qs.limit ? Number(rows[rows.length - 1].id) : null,
    };
  });
}
