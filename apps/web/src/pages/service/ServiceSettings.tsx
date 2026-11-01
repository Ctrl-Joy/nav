import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eraser, Plus, RotateCw, Trash2 } from 'lucide-react';
import type { AutoDeploy, Runtime, Service, StaticHeader, StaticRoute, UpdateServiceInput } from '@nav/shared';
import { useLogStreams, useRegistryCredentials } from '@/api/integrations';
import {
  useDeleteService,
  useDeleteServiceLogStream,
  usePurgeCache,
  useRotateDeployHook,
  useSaveServiceLogStream,
  useServiceLogStream,
  useUpdateService,
  type ServiceUpdate,
} from '@/api/services';
import { useBranches } from '@/api/workspaces';
import { IpRulesEditor, normalizeRules, rulesValid, type IpRule } from '@/components/IpRulesEditor';
import { LogStreamFields, logStreamDirty, logStreamDraft, logStreamEndpointError, logStreamInput } from '@/components/LogStreamFields';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ErrorState,
  IconButton,
  Input,
  SecretValue,
  Select,
  SettingRow,
  SkeletonRows,
  Switch,
  Textarea,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { describeCron } from '@/lib/cron';
import { repoSlug } from '@/lib/format';
import { useServiceCtx } from './context';
import { CustomDomainsCard } from './ServiceDomains';

const RUNTIMES: Runtime[] = ['auto', 'node', 'python', 'go', 'ruby', 'bun', 'docker', 'image', 'static'];

interface BuildForm {
  branch: string;
  rootDir: string;
  runtime: Runtime;
  buildCommand: string;
  startCommand: string;
  preDeployCommand: string;
  dockerfilePath: string;
  dockerContext: string;
  publishPath: string;
  healthCheckPath: string;
  cronSchedule: string;
  autoDeploy: AutoDeploy;
  paths: string;
  ignoredPaths: string;
}

const AUTO_DEPLOY_OPTIONS: { value: AutoDeploy; label: string }[] = [
  { value: 'commit', label: 'On commit' },
  { value: 'checks', label: 'After CI checks pass' },
  { value: 'off', label: 'Off' },
];

function toForm(s: Service): BuildForm {
  return {
    branch: s.branch ?? '',
    rootDir: s.rootDir ?? '',
    runtime: s.runtime,
    buildCommand: s.buildCommand ?? '',
    startCommand: s.startCommand ?? '',
    preDeployCommand: s.preDeployCommand ?? '',
    dockerfilePath: s.dockerfilePath ?? '',
    dockerContext: s.dockerContext ?? '',
    publishPath: s.publishPath ?? '',
    healthCheckPath: s.healthCheckPath ?? '',
    cronSchedule: s.cronSchedule ?? '',
    autoDeploy: s.autoDeploy,
    paths: s.buildFilter.paths.join('\n'),
    ignoredPaths: s.buildFilter.ignoredPaths.join('\n'),
  };
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const nullable = (s: string) => (s.trim() ? s.trim() : null);

function diff(s: Service, f: BuildForm): UpdateServiceInput {
  const a = toForm(s);
  const out: UpdateServiceInput = {};
  if (f.branch !== a.branch) out.branch = nullable(f.branch);
  if (f.rootDir !== a.rootDir) out.rootDir = f.rootDir.trim();
  if (f.runtime !== a.runtime) out.runtime = f.runtime;
  if (f.buildCommand !== a.buildCommand) out.buildCommand = nullable(f.buildCommand);
  if (f.startCommand !== a.startCommand) out.startCommand = nullable(f.startCommand);
  if (f.preDeployCommand !== a.preDeployCommand) out.preDeployCommand = nullable(f.preDeployCommand);
  if (f.dockerfilePath !== a.dockerfilePath) out.dockerfilePath = f.dockerfilePath.trim();
  if (f.dockerContext !== a.dockerContext) out.dockerContext = f.dockerContext.trim();
  if (f.publishPath !== a.publishPath) out.publishPath = nullable(f.publishPath);
  if (f.healthCheckPath !== a.healthCheckPath) out.healthCheckPath = nullable(f.healthCheckPath);
  if (f.cronSchedule !== a.cronSchedule) out.cronSchedule = nullable(f.cronSchedule);
  if (f.autoDeploy !== a.autoDeploy) out.autoDeploy = f.autoDeploy;
  if (f.paths !== a.paths || f.ignoredPaths !== a.ignoredPaths) out.buildFilter = { paths: lines(f.paths), ignoredPaths: lines(f.ignoredPaths) };
  return out;
}

function useSave(service: Service) {
  const update = useUpdateService(service);
  const toast = useToast();
  return {
    pending: update.isPending,
    save: async (input: ServiceUpdate, msg = 'Settings saved') => {
      if (!Object.keys(input).length) return true;
      try {
        await update.mutateAsync(input);
        toast.success(msg);
        return true;
      } catch (e) {
        toast.fromError(e, 'Could not save settings');
        return false;
      }
    },
  };
}

function SectionFooter({ dirty, pending, onSave, onReset, note }: { dirty: boolean; pending: boolean; onSave: () => void; onReset: () => void; note?: ReactNode }) {
  return (
    <CardFooter>
      {note && <span className="mr-auto text-xs text-fg-subtle">{note}</span>}
      <Button variant="ghost" size="sm" disabled={!dirty || pending} onClick={onReset}>
        Discard
      </Button>
      <Button variant="primary" size="sm" disabled={!dirty} loading={pending} onClick={onSave}>
        Save changes
      </Button>
    </CardFooter>
  );
}

function GeneralCard({ service }: { service: Service }) {
  const { canWrite } = useWorkspace();
  const [name, setName] = useState(service.name);
  useEffect(() => setName(service.name), [service.name]);
  const { save, pending } = useSave(service);
  return (
    <Card>
      <CardHeader title="General" />
      <SettingRow title="Name" description="Display name. The service URL slug does not change.">
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} aria-label="Service name" />
      </SettingRow>
      <SettingRow title="Service ID">
        <code className="font-mono text-xs text-fg-muted">{service.id}</code>
      </SettingRow>
      {canWrite && (
        <SectionFooter dirty={name.trim() !== service.name && !!name.trim()} pending={pending} onSave={() => save({ name: name.trim() })} onReset={() => setName(service.name)} />
      )}
    </Card>
  );
}

function BuildCard({ service }: { service: Service }) {
  const { canWrite } = useWorkspace();
  const [form, setForm] = useState(() => toForm(service));
  useEffect(() => setForm(toForm(service)), [service]);
  const { save, pending } = useSave(service);
  const changes = useMemo(() => diff(service, form), [service, form]);
  const dirty = Object.keys(changes).length > 0;
  const branches = useBranches(service.repoUrl);
  const set = <K extends keyof BuildForm>(k: K, v: BuildForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const cron = service.type === 'cron' ? describeCron(form.cronSchedule) : null;
  const isDocker = form.runtime === 'docker';
  const isImage = form.runtime === 'image' || !!service.imageUrl;
  const text = (k: keyof BuildForm, placeholder?: string, mono = true) => (
    <Input mono={mono} value={String(form[k])} onChange={(e) => set(k, e.target.value as never)} placeholder={placeholder} disabled={!canWrite} />
  );

  const branchOptions = Array.from(new Set([...(branches.data?.items ?? []), form.branch].filter(Boolean))).map((b) => ({ value: b, label: b }));

  return (
    <Card>
      <CardHeader title="Build & deploy" description="Changes apply on the next deploy." />
      {service.repoUrl && (
        <SettingRow title="Repository">
          <a href={service.repoUrl} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-accent hover:underline">
            {repoSlug(service.repoUrl)}
          </a>
        </SettingRow>
      )}
      {service.imageUrl && (
        <SettingRow title="Image">
          <code className="font-mono text-[13px] break-all text-fg-muted">{service.imageUrl}</code>
        </SettingRow>
      )}
      {service.repoUrl && (
        <SettingRow title="Branch" description="Pushes to this branch trigger auto-deploys.">
          {branchOptions.length > 1 ? (
            <Select value={form.branch} onChange={(e) => set('branch', e.target.value)} options={branchOptions} disabled={!canWrite} aria-label="Branch" />
          ) : (
            text('branch', 'main')
          )}
        </SettingRow>
      )}
      {!isImage && (
        <>
          <SettingRow title="Root directory" description="Run builds from this subdirectory (monorepos).">
            {text('rootDir', '.')}
          </SettingRow>
          <SettingRow title="Runtime">
            <Select value={form.runtime} onChange={(e) => set('runtime', e.target.value as Runtime)} options={RUNTIMES.map((r) => ({ value: r, label: r }))} disabled={!canWrite} aria-label="Runtime" />
          </SettingRow>
        </>
      )}
      {isDocker && (
        <>
          <SettingRow title="Dockerfile path">{text('dockerfilePath', './Dockerfile')}</SettingRow>
          <SettingRow title="Docker build context">{text('dockerContext', '.')}</SettingRow>
        </>
      )}
      {!isDocker && !isImage && (
        <SettingRow title="Build command" description="Leave empty to use the runtime default.">
          {text('buildCommand', 'npm ci && npm run build')}
        </SettingRow>
      )}
      {service.type === 'static' ? (
        <SettingRow title="Publish directory">{text('publishPath', 'dist')}</SettingRow>
      ) : (
        <>
          <SettingRow title={service.type === 'cron' ? 'Command' : 'Start command'}>{text('startCommand', 'npm start')}</SettingRow>
          <SettingRow title="Pre-deploy command" description="Runs before each deploy goes live, e.g. database migrations.">
            {text('preDeployCommand', 'npm run migrate')}
          </SettingRow>
        </>
      )}
      {service.type === 'web' && (
        <SettingRow title="Health check path" description="NAV waits for a 2xx/3xx here before routing traffic to new instances.">
          {text('healthCheckPath', '/healthz')}
        </SettingRow>
      )}
      {service.type === 'cron' && (
        <SettingRow title="Schedule" description="Cron expression, evaluated in UTC.">
          {text('cronSchedule', '*/5 * * * *')}
          {cron && <p className={`mt-1 text-xs ${cron.valid ? 'text-fg-muted' : 'text-danger'}`}>{cron.valid ? cron.description : cron.error}</p>}
        </SettingRow>
      )}
      {service.repoUrl && (
        <>
          <SettingRow title="Auto-deploy" description="Deploy automatically on every push to the branch, or only once the commit's GitHub checks have passed.">
            <Select
              value={form.autoDeploy}
              onChange={(e) => set('autoDeploy', e.target.value as AutoDeploy)}
              options={AUTO_DEPLOY_OPTIONS}
              disabled={!canWrite}
              aria-label="Auto-deploy"
              className="max-w-xs"
            />
            {form.autoDeploy === 'checks' && (
              <p className="mt-1 text-xs text-fg-muted">
                Waits for every check run and commit status on the pushed commit (success, neutral or skipped). If any fails, the commit is not deployed. Requires the GitHub App.
              </p>
            )}
          </SettingRow>
          <SettingRow title="Build filters" description="Only deploy when changed files match (one glob per line). Ignored paths never trigger a deploy.">
            <div className="grid gap-2 sm:grid-cols-2">
              <Textarea mono rows={3} value={form.paths} onChange={(e) => set('paths', e.target.value)} placeholder="src/**" aria-label="Included paths" disabled={!canWrite} />
              <Textarea mono rows={3} value={form.ignoredPaths} onChange={(e) => set('ignoredPaths', e.target.value)} placeholder="docs/**" aria-label="Ignored paths" disabled={!canWrite} />
            </div>
          </SettingRow>
        </>
      )}
      {canWrite && (
        <SectionFooter dirty={dirty} pending={pending} onSave={() => save(changes)} onReset={() => setForm(toForm(service))} note={dirty ? 'Unsaved changes' : undefined} />
      )}
    </Card>
  );
}

function RowsEditor<T>({
  rows,
  onChange,
  blank,
  columns,
  disabled,
  addLabel,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  blank: T;
  columns: { key: keyof T; placeholder: string; options?: string[]; className?: string }[];
  disabled: boolean;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          {columns.map((c) =>
            c.options ? (
              <Select
                key={String(c.key)}
                className={c.className ?? 'w-28'}
                value={String(r[c.key])}
                options={c.options.map((o) => ({ value: o, label: o }))}
                disabled={disabled}
                aria-label={c.placeholder}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))}
              />
            ) : (
              <Input
                key={String(c.key)}
                mono
                className={c.className ?? 'min-w-0 flex-1'}
                value={String(r[c.key])}
                placeholder={c.placeholder}
                aria-label={c.placeholder}
                disabled={disabled}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))}
              />
            ),
          )}
          {!disabled && <IconButton label="Remove row" icon={<Trash2 className="size-3.5" />} onClick={() => onChange(rows.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {!disabled && (
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { ...blank }])}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}

function StaticCard({ service }: { service: Service }) {
  const { canWrite } = useWorkspace();
  const [routes, setRoutes] = useState<StaticRoute[]>(service.staticRoutes);
  const [headers, setHeaders] = useState<StaticHeader[]>(service.staticHeaders);
  useEffect(() => setRoutes(service.staticRoutes), [service.staticRoutes]);
  useEffect(() => setHeaders(service.staticHeaders), [service.staticHeaders]);
  const { save, pending } = useSave(service);
  const dirty = JSON.stringify(routes) !== JSON.stringify(service.staticRoutes) || JSON.stringify(headers) !== JSON.stringify(service.staticHeaders);
  return (
    <Card>
      <CardHeader title="Redirects, rewrites & headers" description="Rules are evaluated in order. Add a rewrite /* → /index.html for single-page apps." />
      <SettingRow title="Redirects & rewrites">
        <RowsEditor<StaticRoute>
          rows={routes}
          onChange={setRoutes}
          blank={{ type: 'rewrite', source: '', destination: '' }}
          disabled={!canWrite}
          addLabel="Add rule"
          columns={[
            { key: 'type', placeholder: 'Type', options: ['redirect', 'rewrite'] },
            { key: 'source', placeholder: '/source/*' },
            { key: 'destination', placeholder: '/destination' },
          ]}
        />
      </SettingRow>
      <SettingRow title="Response headers">
        <RowsEditor<StaticHeader>
          rows={headers}
          onChange={setHeaders}
          blank={{ path: '/*', name: '', value: '' }}
          disabled={!canWrite}
          addLabel="Add header"
          columns={[
            { key: 'path', placeholder: '/*', className: 'w-28' },
            { key: 'name', placeholder: 'Header name' },
            { key: 'value', placeholder: 'Value' },
          ]}
        />
      </SettingRow>
      {canWrite && (
        <SectionFooter
          dirty={dirty}
          pending={pending}
          onSave={() =>
            save({
              staticRoutes: routes.filter((r) => r.source.trim() && r.destination.trim()),
              staticHeaders: headers.filter((h) => h.name.trim()),
            })
          }
          onReset={() => {
            setRoutes(service.staticRoutes);
            setHeaders(service.staticHeaders);
          }}
        />
      )}
    </Card>
  );
}

function OperationsCard({ service }: { service: Service }) {
  const { canWrite } = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const rotate = useRotateDeployHook(service);
  const { save, pending } = useSave(service);
  return (
    <Card>
      <CardHeader title="Deploy hook & maintenance" />
      <SettingRow title="Deploy hook" description="POST to this private URL to trigger a deploy (CI, CMS webhooks). Treat it like a secret.">
        <div className="flex flex-wrap items-center gap-2">
          <SecretValue value={service.deployHookUrl} className="min-w-0 flex-1" />
          {canWrite && (
            <Button
              size="sm"
              icon={<RotateCw className="size-3.5" />}
              loading={rotate.isPending}
              onClick={async () => {
                if (!(await confirm({ title: 'Regenerate deploy hook?', body: 'The current URL stops working immediately.', confirmText: 'Regenerate', danger: true }))) return;
                try {
                  await rotate.mutateAsync();
                  toast.success('Deploy hook regenerated');
                } catch (e) {
                  toast.fromError(e);
                }
              }}
            >
              Regenerate
            </Button>
          )}
        </div>
      </SettingRow>
      {(service.type === 'web' || service.type === 'static') && (
        <SettingRow title="Maintenance mode" description="Serve a 503 maintenance page for all requests while you work on the service.">
          <Switch
            checked={service.maintenanceMode}
            disabled={!canWrite || pending}
            label={service.maintenanceMode ? 'Enabled' : 'Disabled'}
            onChange={(v) => save({ maintenanceMode: v }, v ? 'Maintenance mode enabled' : 'Maintenance mode disabled')}
          />
        </SettingRow>
      )}
    </Card>
  );
}

function InboundRulesCard({ service }: { service: Service }) {
  const { canWrite } = useWorkspace();
  const [rows, setRows] = useState<IpRule[]>(service.ipAllowList);
  useEffect(() => setRows(service.ipAllowList), [service.ipAllowList]);
  const { save, pending } = useSave(service);
  const dirty = JSON.stringify(rows) !== JSON.stringify(service.ipAllowList);
  return (
    <Card>
      <CardHeader title="Inbound IP rules" description="Only requests from these sources reach the service through its public URL and custom domains. Others get a 403." />
      <CardBody>
        <IpRulesEditor
          rows={rows}
          onChange={setRows}
          disabled={!canWrite}
          emptyText="No rules. Requests from everywhere are allowed."
          footnote="An empty list allows everyone. Traffic from the workspace private network is never filtered."
        />
      </CardBody>
      {canWrite && (
        <SectionFooter
          dirty={dirty}
          pending={pending}
          onSave={() => rulesValid(rows) && save({ ipAllowList: normalizeRules(rows) }, 'Inbound IP rules saved')}
          onReset={() => setRows(service.ipAllowList)}
          note={dirty && !rulesValid(rows) ? 'Fix the invalid rules to save' : undefined}
        />
      )}
    </Card>
  );
}

function EdgeCacheCard({ service }: { service: Service }) {
  const { canWrite } = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const purge = usePurgeCache(service.id);
  const [enabled, setEnabled] = useState(service.edgeCache.enabled);
  const [ttl, setTtl] = useState(service.edgeCache.maxTtlSeconds ?? 86_400);
  useEffect(() => {
    setEnabled(service.edgeCache.enabled);
    setTtl(service.edgeCache.maxTtlSeconds ?? 86_400);
  }, [service.edgeCache]);
  const { save, pending } = useSave(service);
  const dirty = enabled !== service.edgeCache.enabled || ttl !== (service.edgeCache.maxTtlSeconds ?? 86_400);
  const ttlInvalid = !Number.isInteger(ttl) || ttl < 1 || ttl > 31_536_000;
  return (
    <Card>
      <CardHeader title="Edge caching" description="Cache responses at the NAV edge when your app sends Cache-Control headers that allow it (public, max-age / s-maxage)." />
      <SettingRow title="Cache responses" description="Serve cacheable responses from the edge instead of your instances.">
        <Switch checked={enabled} onChange={setEnabled} disabled={!canWrite} label={enabled ? 'Enabled' : 'Disabled'} />
      </SettingRow>
      <SettingRow title="Maximum TTL" description="Upper bound on how long a response stays cached, whatever its headers say.">
        <div className="flex items-center gap-2">
          <Input type="number" min={1} max={31_536_000} className="w-36" value={ttl} onChange={(e) => setTtl(Number(e.target.value))} disabled={!canWrite || !enabled} aria-label="Maximum TTL in seconds" aria-invalid={ttlInvalid} />
          <span className="text-[13px] text-fg-muted">seconds{Number.isInteger(ttl) && ttl >= 3600 ? ` (${+(ttl / 3600).toFixed(1)} h)` : ''}</span>
        </div>
      </SettingRow>
      {canWrite && (
        <SettingRow title="Purge cache" description="Drop every cached response for this service now.">
          <Button
            icon={<Eraser className="size-3.5" />}
            loading={purge.isPending}
            disabled={!service.edgeCache.enabled}
            onClick={async () => {
              if (!(await confirm({ title: 'Purge the edge cache?', body: 'The next requests go to your service until responses are cached again.', confirmText: 'Purge cache' }))) return;
              try {
                await purge.mutateAsync();
                toast.success('Edge cache purged');
              } catch (e) {
                toast.fromError(e, 'Could not purge cache');
              }
            }}
          >
            Purge cache
          </Button>
        </SettingRow>
      )}
      {canWrite && (
        <SectionFooter
          dirty={dirty && !ttlInvalid}
          pending={pending}
          onSave={() => save({ edgeCache: { enabled, maxTtlSeconds: ttl } }, 'Edge caching saved')}
          onReset={() => {
            setEnabled(service.edgeCache.enabled);
            setTtl(service.edgeCache.maxTtlSeconds ?? 86_400);
          }}
        />
      )}
    </Card>
  );
}

function RuntimeCard({ service }: { service: Service }) {
  const { ws, canWrite } = useWorkspace();
  const isImage = service.runtime === 'image';
  const creds = useRegistryCredentials(ws, isImage && canWrite);
  const [delay, setDelay] = useState(service.shutdownDelaySeconds);
  const [cred, setCred] = useState(service.registryCredentialId ?? '');
  useEffect(() => setDelay(service.shutdownDelaySeconds), [service.shutdownDelaySeconds]);
  useEffect(() => setCred(service.registryCredentialId ?? ''), [service.registryCredentialId]);
  const { save, pending } = useSave(service);
  const delayInvalid = !Number.isInteger(delay) || delay < 1 || delay > 300;
  const changes: ServiceUpdate = {};
  if (delay !== service.shutdownDelaySeconds) changes.shutdownDelaySeconds = delay;
  if (isImage && cred !== (service.registryCredentialId ?? '')) changes.registryCredentialId = cred || null;
  const dirty = Object.keys(changes).length > 0;
  return (
    <Card>
      <CardHeader title="Runtime" description="Changes apply on the next deploy." />
      {service.type !== 'cron' && (
        <SettingRow
          title="Graceful shutdown delay"
          description="How long an old instance gets after SIGTERM to finish in-flight work before it is killed (1–300 seconds)."
        >
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={300} className="w-28" value={delay} onChange={(e) => setDelay(Number(e.target.value))} disabled={!canWrite} aria-label="Shutdown delay in seconds" aria-invalid={delayInvalid} />
            <span className="text-[13px] text-fg-muted">seconds</span>
          </div>
          {delayInvalid && <p className="mt-1 text-xs text-danger">Between 1 and 300 seconds.</p>}
        </SettingRow>
      )}
      {isImage && (
        <SettingRow title="Registry credential" description="Used to pull the image from a private registry. Manage credentials in workspace settings.">
          {creds.isError ? (
            <p className="text-xs text-danger">Could not load registry credentials.</p>
          ) : (
            <Select
              value={cred}
              onChange={(e) => setCred(e.target.value)}
              placeholder="None (public image)"
              options={(creds.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} · ${c.registry}` }))}
              disabled={!canWrite}
              aria-label="Registry credential"
            />
          )}
        </SettingRow>
      )}
      {canWrite && (
        <SectionFooter
          dirty={dirty && !delayInvalid}
          pending={pending}
          onSave={() => save(changes)}
          onReset={() => {
            setDelay(service.shutdownDelaySeconds);
            setCred(service.registryCredentialId ?? '');
          }}
        />
      )}
    </Card>
  );
}

type StreamMode = 'default' | 'custom' | 'off';

/** Per-service log stream: inherit the workspace default, send elsewhere, or opt out. Admins only. */
function LogStreamCard({ service }: { service: Service }) {
  const { ws } = useWorkspace();
  const override = useServiceLogStream(service.id);
  const workspace = useLogStreams(ws);
  const saveStream = useSaveServiceLogStream(service.id);
  const del = useDeleteServiceLogStream(service.id);
  const toast = useToast();
  const current = override.data?.override ?? null;
  const serverMode: StreamMode = !current ? 'default' : current.enabled ? 'custom' : 'off';
  const [mode, setMode] = useState<StreamMode>(serverMode);
  const [draft, setDraft] = useState(() => logStreamDraft(current));
  useEffect(() => {
    setMode(serverMode);
    setDraft(logStreamDraft(current?.enabled ? current : null));
  }, [current, serverMode]);
  const fallback = workspace.data?.default ?? null;

  const dirty = mode !== serverMode || (mode === 'custom' && logStreamDirty({ ...draft, enabled: true }, current));
  const invalid = mode === 'custom' && (!draft.endpoint.trim() || !!logStreamEndpointError(draft));
  // Opting out still stores a (disabled) destination: reuse this service's or the workspace's.
  const optOutTarget = current ?? fallback;

  const onSave = async () => {
    try {
      if (mode === 'default') await del.mutateAsync();
      else if (mode === 'custom') await saveStream.mutateAsync({ ...logStreamInput(draft), enabled: true });
      else if (optOutTarget) await saveStream.mutateAsync({ protocol: optOutTarget.protocol, endpoint: optOutTarget.endpoint, enabled: false });
      toast.success('Log stream saved');
    } catch (e) {
      toast.fromError(e, 'Could not save log stream');
    }
  };

  return (
    <Card>
      <div id="log-stream" className="scroll-mt-24" />
      <CardHeader title="Log stream" description="Where this service's runtime logs are forwarded." />
      {override.isPending ? (
        <CardBody>
          <SkeletonRows rows={2} />
        </CardBody>
      ) : override.isError ? (
        <CardBody>
          <ErrorState error={override.error} onRetry={() => override.refetch()} />
        </CardBody>
      ) : (
        <>
          <SettingRow
            title="Destination"
            description={fallback ? <>Workspace default: <span className="font-mono">{fallback.endpoint}</span></> : 'This workspace has no default log stream.'}
          >
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as StreamMode)}
              aria-label="Log stream destination"
              options={[
                { value: 'default', label: 'Use the workspace default' },
                { value: 'custom', label: 'Send to a different destination' },
                { value: 'off', label: "Don't stream this service's logs", disabled: !optOutTarget },
              ]}
            />
            {current?.lastError && <p className="mt-2 font-mono text-xs break-all text-danger">{current.lastError}</p>}
          </SettingRow>
          {mode === 'custom' && (
            <CardBody className="border-b border-border">
              <LogStreamFields draft={{ ...draft, enabled: true }} onChange={(d) => setDraft({ ...d, enabled: true })} hasToken={!!current?.hasToken && current.enabled} />
            </CardBody>
          )}
          <SectionFooter
            dirty={dirty && !invalid}
            pending={saveStream.isPending || del.isPending}
            onSave={onSave}
            onReset={() => {
              setMode(serverMode);
              setDraft(logStreamDraft(current?.enabled ? current : null));
            }}
          />
        </>
      )}
    </Card>
  );
}

function DangerCard({ service }: { service: Service }) {
  const { ws } = useWorkspace();
  const del = useDeleteService(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <Card className="border-danger/40">
      <CardHeader title={<span className="text-danger">Danger zone</span>} />
      <SettingRow title="Delete service" description="Stops all instances, removes routes and custom domains, and deletes logs, deploys and data. This cannot be undone.">
        <Button
          variant="outline-danger"
          icon={<Trash2 className="size-3.5" />}
          loading={del.isPending}
          onClick={async () => {
            const ok = await confirm({ title: `Delete ${service.name}?`, body: 'This permanently deletes the service and everything attached to it.', confirmText: 'Delete service', danger: true, typeToConfirm: service.name });
            if (!ok) return;
            try {
              await del.mutateAsync(service.id);
              toast.success('Service deleted', service.name);
              navigate(`/w/${ws}`);
            } catch (e) {
              toast.fromError(e, 'Could not delete service');
            }
          }}
        >
          Delete service
        </Button>
      </SettingRow>
    </Card>
  );
}

export function ServiceSettingsTab() {
  const { service } = useServiceCtx();
  const { isAdmin } = useWorkspace();
  return (
    <div className="space-y-6">
      <GeneralCard service={service} />
      <BuildCard service={service} />
      {(service.type === 'web' || service.type === 'static') && <CustomDomainsCard service={service} />}
      {service.type === 'static' && <StaticCard service={service} />}
      {(service.type === 'web' || service.type === 'static') && <InboundRulesCard service={service} />}
      {service.type === 'web' && <EdgeCacheCard service={service} />}
      {((service.type !== 'static' && service.type !== 'cron') || service.runtime === 'image') && <RuntimeCard service={service} />}
      <OperationsCard service={service} />
      {isAdmin && service.type !== 'static' && <LogStreamCard service={service} />}
      {isAdmin && <DangerCard service={service} />}
    </div>
  );
}
