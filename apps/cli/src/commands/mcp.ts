// `nav mcp`: a Model Context Protocol server over stdio, so AI coding agents can inspect and operate NAV with the
// user's API key. Every tool is a thin call to the REST API, so the key's workspace roles apply unchanged.
import { createInterface } from 'node:readline';
import type { CommandDef } from '../command.ts';
import { authContext, type AuthContext } from '../context.ts';
import { VERSION } from '../version.ts';

type Json = Record<string, unknown>;
interface Tool { name: string; description: string; inputSchema: Json; readOnly: boolean; run: (ctx: AuthContext, a: Json) => Promise<unknown> }

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;

async function workspaceOf(ctx: AuthContext, a: Json): Promise<string> {
  if (typeof a.workspaceId === 'string') return a.workspaceId;
  if (ctx.config.workspaceId) return ctx.config.workspaceId;
  const ws = await ctx.client.get<{ id: string }[]>('/workspaces');
  if (ws.length === 1) return ws[0].id;
  throw new Error('several workspaces: pass workspaceId (see list_workspaces)');
}

const TOOLS: Tool[] = [
  { name: 'list_workspaces', description: 'List the workspaces this API key can access.', readOnly: true, inputSchema: obj({}), run: (c) => c.client.get('/workspaces') },
  { name: 'list_services', description: 'List services (web, private, worker, cron, static) in a workspace.', readOnly: true, inputSchema: obj({ workspaceId: str('Workspace id; defaults to the CLI\'s current workspace') }), run: async (c, a) => c.client.get(`/workspaces/${enc(await workspaceOf(c, a))}/services`) },
  { name: 'get_service', description: 'Get a service\'s configuration and status.', readOnly: true, inputSchema: obj({ serviceId: str('Service id') }, ['serviceId']), run: (c, a) => c.client.get(`/services/${enc(String(a.serviceId))}`) },
  { name: 'list_deploys', description: 'List recent deploys of a service, newest first.', readOnly: true, inputSchema: obj({ serviceId: str('Service id') }, ['serviceId']), run: (c, a) => c.client.get(`/services/${enc(String(a.serviceId))}/deploys`) },
  { name: 'get_logs', description: 'Fetch recent logs of a service.', readOnly: true, inputSchema: obj({ serviceId: str('Service id'), limit: { type: 'number', description: 'Max lines (default 200)' }, stream: str('Comma-separated: build, deploy, runtime, cron, job, system'), text: str('Only lines containing this text') }, ['serviceId']), run: (c, a) => c.client.get(`/services/${enc(String(a.serviceId))}/logs`, { limit: (a.limit as number) ?? 200, stream: a.stream as string, text: a.text as string }) },
  { name: 'get_metrics', description: 'CPU, memory and HTTP metrics of a service.', readOnly: true, inputSchema: obj({ serviceId: str('Service id'), range: { type: 'string', enum: ['1h', '6h', '24h', '7d'] } }, ['serviceId']), run: (c, a) => c.client.get(`/services/${enc(String(a.serviceId))}/metrics`, { range: (a.range as string) ?? '1h' }) },
  { name: 'list_env_vars', description: 'List a service\'s environment variables.', readOnly: true, inputSchema: obj({ serviceId: str('Service id') }, ['serviceId']), run: (c, a) => c.client.get(`/services/${enc(String(a.serviceId))}/env-vars`) },
  { name: 'list_databases', description: 'List Postgres databases in a workspace.', readOnly: true, inputSchema: obj({ workspaceId: str('Workspace id') }), run: async (c, a) => c.client.get(`/workspaces/${enc(await workspaceOf(c, a))}/databases`) },
  { name: 'list_key_value', description: 'List Key Value (Redis-compatible) instances in a workspace.', readOnly: true, inputSchema: obj({ workspaceId: str('Workspace id') }), run: async (c, a) => c.client.get(`/workspaces/${enc(await workspaceOf(c, a))}/key-value`) },
  { name: 'query_database', description: 'Run a SQL statement against a Postgres database and return the rows.', readOnly: false, inputSchema: obj({ databaseId: str('Database id'), sql: str('SQL to run') }, ['databaseId', 'sql']), run: (c, a) => c.client.post(`/databases/${enc(String(a.databaseId))}/query`, { sql: a.sql }) },
  { name: 'trigger_deploy', description: 'Deploy the latest commit (or a given one) of a service.', readOnly: false, inputSchema: obj({ serviceId: str('Service id'), commitSha: str('Optional commit to deploy'), clearCache: { type: 'boolean' } }, ['serviceId']), run: (c, a) => c.client.post(`/services/${enc(String(a.serviceId))}/deploys`, { commitSha: a.commitSha, clearCache: a.clearCache }) },
  { name: 'rollback_deploy', description: 'Redeploy the build of an earlier deploy.', readOnly: false, inputSchema: obj({ deployId: str('Deploy id to roll back to') }, ['deployId']), run: (c, a) => c.client.post(`/deploys/${enc(String(a.deployId))}/rollback`) },
  { name: 'restart_service', description: 'Rolling restart of a service\'s instances.', readOnly: false, inputSchema: obj({ serviceId: str('Service id') }, ['serviceId']), run: (c, a) => c.client.post(`/services/${enc(String(a.serviceId))}/restart`) },
  { name: 'scale_service', description: 'Set the number of instances of a service.', readOnly: false, inputSchema: obj({ serviceId: str('Service id'), instanceCount: { type: 'number', minimum: 1, maximum: 100 } }, ['serviceId', 'instanceCount']), run: (c, a) => c.client.post(`/services/${enc(String(a.serviceId))}/scale`, { instanceCount: a.instanceCount }) },
  { name: 'update_env_vars', description: 'Set and/or remove environment variables, then redeploy (unless deploy is false).', readOnly: false, inputSchema: obj({ serviceId: str('Service id'), set: { type: 'array', items: obj({ key: str('Name'), value: str('Value') }, ['key', 'value']) }, remove: { type: 'array', items: { type: 'string' } }, deploy: { type: 'boolean' } }, ['serviceId']), run: (c, a) => c.client.patch(`/services/${enc(String(a.serviceId))}/env-vars`, { set: a.set, remove: a.remove, deploy: a.deploy }) },
];

function write(msg: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}

async function serve(argv: string[]): Promise<void> {
  const readOnly = argv.includes('--read-only');
  const ctx = await authContext();
  const tools = TOOLS.filter((t) => !readOnly || t.readOnly);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    const { id, method } = msg as { id?: string | number; method?: string };
    const params = (msg.params ?? {}) as Json;
    if (id === undefined) continue; // notifications (initialized, cancelled) need no answer
    try {
      if (method === 'initialize') {
        write({ id, result: { protocolVersion: (params.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nav', version: VERSION }, instructions: 'Tools for the NAV hosting platform: inspect services, deploys, logs and metrics; deploy, roll back, scale and configure. Ids come from the list_* tools.' } });
      } else if (method === 'ping') {
        write({ id, result: {} });
      } else if (method === 'tools/list') {
        write({ id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly } })) } });
      } else if (method === 'tools/call') {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) { write({ id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } }); continue; }
        try {
          const data = await tool.run(ctx, (params.arguments ?? {}) as Json);
          write({ id, result: { content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }] } });
        } catch (err) {
          write({ id, result: { isError: true, content: [{ type: 'text', text: (err as Error).message }] } });
        }
      } else {
        write({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      write({ id, error: { code: -32603, message: (err as Error).message } });
    }
  }
}

export const mcpCommands: CommandDef[] = [
  {
    name: 'mcp',
    summary: 'Run an MCP server on stdio for AI coding agents',
    usage: ['nav mcp [--read-only]', 'Add to your agent: { "command": "nav", "args": ["mcp"] } (uses NAV_TOKEN or your nav login)'],
    run: serve,
  },
];
