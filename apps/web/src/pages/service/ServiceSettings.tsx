import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RotateCw, Trash2 } from 'lucide-react';
import type { Runtime, Service, StaticHeader, StaticRoute, UpdateServiceInput } from '@nav/shared';
import { useDeleteService, useRotateDeployHook, useUpdateService } from '@/api/services';
import { useBranches } from '@/api/workspaces';
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  IconButton,
  Input,
  SecretValue,
  Select,
  SettingRow,
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
  autoDeploy: boolean;
  paths: string;
  ignoredPaths: string;
}

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
    autoDeploy: s.autoDeploy === 'commit',
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
  if (f.autoDeploy !== a.autoDeploy) out.autoDeploy = f.autoDeploy ? 'commit' : 'off';
  if (f.paths !== a.paths || f.ignoredPaths !== a.ignoredPaths) out.buildFilter = { paths: lines(f.paths), ignoredPaths: lines(f.ignoredPaths) };
  return out;
}

function useSave(service: Service) {
  const update = useUpdateService(service);
  const toast = useToast();
  return {
    pending: update.isPending,
    save: async (input: UpdateServiceInput, msg = 'Settings saved') => {
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
          <SettingRow title="Auto-deploy" description="Deploy automatically on every push to the branch.">
            <Switch checked={form.autoDeploy} onChange={(v) => set('autoDeploy', v)} disabled={!canWrite} label={form.autoDeploy ? 'On commit' : 'Off'} />
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
      <OperationsCard service={service} />
      {isAdmin && <DangerCard service={service} />}
    </div>
  );
}
