import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Box, ChevronDown, GitBranch, Globe, Lock, Search } from 'lucide-react';
import { Github } from '@/components/GithubIcon';
import { SERVICE_PLANS, slugify, type CreateServiceInput, type EnvVar, type Runtime, type SecretFile, type ServiceType } from '@nav/shared';
import { errorMessage } from '@/api/client';
import { useEnvGroups } from '@/api/resources';
import { useCreateService } from '@/api/services';
import { useBranches, useProjects, useRepos } from '@/api/workspaces';
import { cleanEnvVars, envVarErrors, EnvVarEditor, SecretFilesEditor } from '@/components/EnvEditor';
import { PlanPicker } from '@/components/PlanPicker';
import { RESOURCE_META } from '@/components/ResourceIcon';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Empty,
  Field,
  Input,
  Segmented,
  Select,
  Skeleton,
  Switch,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { NotFoundPage } from '@/pages/NotFound';
import { cn } from '@/lib/cn';
import { CRON_PRESETS, describeCron } from '@/lib/cron';
import { repoSlug } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';

const SERVICE_TYPES: ServiceType[] = ['web', 'private', 'worker', 'cron', 'static'];
type SourceKind = 'github' | 'git' | 'image';

const RUNTIMES: { value: Runtime; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'bun', label: 'Bun' },
  { value: 'docker', label: 'Docker (Dockerfile)' },
];

function isGitUrl(v: string): boolean {
  return /^(https?:\/\/[^\s/]+\/\S+|git@[^\s:]+:\S+|ssh:\/\/\S+)$/.test(v.trim());
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody className="space-y-4">{children}</CardBody>
    </Card>
  );
}

function StepIndicator({ step }: { step: 1 | 2 }) {
  const items = ['Source', 'Configure'];
  return (
    <ol className="flex items-center gap-3 text-[13px]" aria-label="Progress">
      {items.map((label, i) => {
        const n = (i + 1) as 1 | 2;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full border font-mono text-[11px]',
                active ? 'border-accent bg-accent text-accent-fg' : done ? 'border-accent text-accent' : 'border-border-strong text-fg-subtle',
              )}
            >
              {n}
            </span>
            <span className={active ? 'font-medium text-fg' : 'text-fg-muted'}>{label}</span>
            {i < items.length - 1 && <span className="mx-1 h-px w-8 bg-border-strong" />}
          </li>
        );
      })}
    </ol>
  );
}

export function NewServicePage() {
  const { type: rawType } = useParams();
  const type = SERVICE_TYPES.includes(rawType as ServiceType) ? (rawType as ServiceType) : null;
  if (!type) return <NotFoundPage />;
  return <Wizard key={type} type={type} />;
}

function Wizard({ type }: { type: ServiceType }) {
  const meta = RESOURCE_META[type];
  useTitle(`New ${meta.label}`);
  const { ws, config, canWrite } = useWorkspace();
  const navigate = useNavigate();
  const create = useCreateService(ws);
  const projects = useProjects(ws);
  const envGroups = useEnvGroups(ws);
  const githubEnabled = !!config?.githubEnabled;
  const repos = useRepos(ws, githubEnabled);

  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState<SourceKind>(githubEnabled ? 'github' : 'git');
  const [repoFilter, setRepoFilter] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [imageUrl, setImageUrl] = useState('');

  const [name, setName] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [runtime, setRuntime] = useState<Runtime>('auto');
  const [buildCommand, setBuildCommand] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [preDeployCommand, setPreDeployCommand] = useState('');
  const [healthCheckPath, setHealthCheckPath] = useState('');
  const [port, setPort] = useState('');
  const [cronSchedule, setCronSchedule] = useState('*/15 * * * *');
  const [publishPath, setPublishPath] = useState('dist');
  const [plan, setPlan] = useState(type === 'static' ? 'free' : 'starter');
  const [instanceCount, setInstanceCount] = useState(1);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [secretFiles, setSecretFiles] = useState<SecretFile[]>([]);
  const [envGroupIds, setEnvGroupIds] = useState<string[]>([]);
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [dockerfilePath, setDockerfilePath] = useState('./Dockerfile');
  const [dockerContext, setDockerContext] = useState('.');
  const [diskEnabled, setDiskEnabled] = useState(false);
  const [disk, setDisk] = useState({ name: 'data', mountPath: '/var/data', sizeGB: 1 });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const branches = useBranches(source === 'image' ? null : repoUrl);
  const cron = describeCron(cronSchedule);
  const isImage = source === 'image';
  const hasHttp = type === 'web' || type === 'private';
  const needsInstances = type === 'web' || type === 'private' || type === 'worker';

  const repoItems = useMemo(() => {
    const needle = repoFilter.toLowerCase();
    return (repos.data?.items ?? []).filter((r) => r.fullName.toLowerCase().includes(needle)).slice(0, 50);
  }, [repos.data, repoFilter]);

  const envOptions = (projects.data?.items ?? []).flatMap((p) => p.environments.map((e) => ({ value: e.id, label: `${p.name} / ${e.name}` })));

  const pickSource = (url: string, defaultBranch?: string) => {
    setRepoUrl(url);
    setBranch(defaultBranch ?? '');
    if (!name) setName(slugify(repoSlug(url).split('/').pop() ?? ''));
    setStep(2);
  };

  const continueFromSource = () => {
    if (isImage) {
      if (!name) setName(slugify(imageUrl.split('/').pop()?.split(':')[0] ?? ''));
      setRuntime('image');
    } else {
      if (runtime === 'image') setRuntime('auto');
      if (!name) setName(slugify(repoSlug(repoUrl).split('/').pop() ?? ''));
    }
    setStep(2);
  };

  const envError = envVarErrors(envVars);
  const nameError = name && !/^[a-zA-Z0-9][\w .-]{0,62}$/.test(name) ? 'Use letters, numbers, spaces, dots, dashes or underscores.' : null;
  const canSubmit = !!name.trim() && !nameError && !envError && (type !== 'cron' || cron.valid) && canWrite;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    const input: CreateServiceInput = {
      name: name.trim(),
      type,
      environmentId: environmentId || null,
      runtime: isImage ? 'image' : runtime,
      repoUrl: isImage ? null : repoUrl.trim(),
      branch: isImage ? null : branch || null,
      imageUrl: isImage ? imageUrl.trim() : null,
      rootDir: rootDir.trim() || undefined,
      buildCommand: isImage ? null : buildCommand.trim() || null,
      startCommand: type === 'static' ? null : startCommand.trim() || null,
      preDeployCommand: type === 'static' ? null : preDeployCommand.trim() || null,
      healthCheckPath: type === 'web' ? healthCheckPath.trim() || null : null,
      port: hasHttp && port ? Number(port) : null,
      cronSchedule: type === 'cron' ? cronSchedule.trim() : null,
      publishPath: type === 'static' ? publishPath.trim() || null : null,
      plan: type === 'static' ? undefined : plan,
      instanceCount: needsInstances ? instanceCount : undefined,
      autoDeploy: isImage ? 'off' : autoDeploy ? 'commit' : 'off',
      envVars: cleanEnvVars(envVars),
      secretFiles: secretFiles.filter((f) => f.filename.trim()),
      envGroupIds,
      ...(runtime === 'docker' && !isImage ? { dockerfilePath, dockerContext } : {}),
      disk: diskEnabled && type !== 'static' && type !== 'cron' ? disk : null,
    };
    try {
      const res = await create.mutateAsync(input);
      navigate(`/w/${ws}/services/${res.service.id}/deploys/${res.deploy.id}`);
    } catch (err) {
      setSubmitError(errorMessage(err));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  if (!canWrite) {
    return <Empty title="Read-only access" description="Viewers can’t create services. Ask a workspace admin to upgrade your role." />;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link to={`/w/${ws}`} className="mb-4 inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Overview
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-2 text-accent">
            <meta.icon className="size-5" />
          </span>
          <div>
            <h1 className="text-[24px] leading-tight font-normal tracking-[-0.02em] md:text-[28px]">New {meta.label}</h1>
            <p className="text-[13px] text-fg-muted">{meta.description}</p>
          </div>
        </div>
        <StepIndicator step={step} />
      </div>

      {step === 1 ? (
        <Card>
          <CardHeader title="Where is your code?" description="Deploy from a connected GitHub repository, any public Git URL, or an existing container image." />
          <CardBody className="space-y-5">
            <Segmented
              label="Source"
              value={source}
              onChange={setSource}
              options={[
                ...(githubEnabled ? [{ value: 'github' as const, label: 'GitHub' }] : []),
                { value: 'git', label: 'Public Git repository' },
                ...(type !== 'static' ? [{ value: 'image' as const, label: 'Existing image' }] : []),
              ]}
            />

            {source === 'github' && (
              <div className="space-y-3">
                <Input leading={<Search className="size-3.5" />} placeholder="Search repositories" aria-label="Search repositories" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
                {repos.isPending ? (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-11" />
                    ))}
                  </div>
                ) : repos.isError ? (
                  <Empty
                    compact
                    icon={<Github className="size-4" />}
                    title="GitHub isn’t connected"
                    description={
                      <>
                        {errorMessage(repos.error)}{' '}
                        <a className="text-accent hover:underline" href="/api/v1/auth/github">
                          Connect GitHub
                        </a>
                      </>
                    }
                  />
                ) : repoItems.length === 0 ? (
                  <Empty compact title="No repositories found" description="Install the NAV GitHub App on more repositories, or use a public Git URL." />
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {repoItems.map((r) => (
                      <li key={r.cloneUrl}>
                        <button
                          type="button"
                          onClick={() => pickSource(r.cloneUrl, r.defaultBranch)}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2"
                        >
                          <Github className="size-4 text-fg-subtle" />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.fullName}</span>
                          {r.private && (
                            <Badge>
                              <Lock className="size-3" /> private
                            </Badge>
                          )}
                          <span className="hidden items-center gap-1 font-mono text-xs text-fg-subtle sm:flex">
                            <GitBranch className="size-3" /> {r.defaultBranch}
                          </span>
                          <ArrowRight className="size-3.5 text-fg-subtle" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {source === 'git' && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (isGitUrl(repoUrl)) continueFromSource();
                }}
              >
                <Field label="Repository URL" hint="Any Git URL NAV can clone, e.g. https://github.com/acme/app" error={repoUrl && !isGitUrl(repoUrl) ? 'Enter a valid Git URL.' : null}>
                  {(id) => (
                    <Input id={id} mono leading={<Globe className="size-3.5" />} value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/acme/app" autoFocus />
                  )}
                </Field>
                <Button type="submit" variant="primary" disabled={!isGitUrl(repoUrl)} iconRight={<ArrowRight className="size-3.5" />}>
                  Continue
                </Button>
              </form>
            )}

            {source === 'image' && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (imageUrl.trim()) continueFromSource();
                }}
              >
                <Field label="Image URL" hint="A public image reference, e.g. ghcr.io/acme/api:1.4.2 or docker.io/library/nginx:alpine">
                  {(id) => <Input id={id} mono leading={<Box className="size-3.5" />} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="docker.io/library/nginx:alpine" autoFocus />}
                </Field>
                <Button type="submit" variant="primary" disabled={!imageUrl.trim()} iconRight={<ArrowRight className="size-3.5" />}>
                  Continue
                </Button>
              </form>
            )}
          </CardBody>
        </Card>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {submitError && (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {submitError}
            </div>
          )}

          <Section title="Source">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
              {isImage ? <Box className="size-4 text-fg-subtle" /> : <Github className="size-4 text-fg-subtle" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{isImage ? imageUrl : repoUrl}</span>
              <Button size="sm" variant="ghost" onClick={() => setStep(1)}>
                Change
              </Button>
            </div>
            {!isImage && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Branch" hint={branches.isError ? 'Could not list branches; type one.' : undefined}>
                  {(id) =>
                    branches.data?.items.length ? (
                      <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Default branch" options={branches.data.items.map((b) => ({ value: b, label: b }))} />
                    ) : (
                      <Input id={id} mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={branches.isFetching ? 'Loading branches…' : 'main'} />
                    )
                  }
                </Field>
                <Field label="Root directory" optional hint="For monorepos: the folder containing this service.">
                  {(id) => <Input id={id} mono value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="services/api" />}
                </Field>
              </div>
            )}
          </Section>

          <Section title="General">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" error={nameError} hint={name ? `URL slug: ${slugify(name)}` : undefined}>
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-api" required />}
              </Field>
              <Field label="Project / environment" optional>
                {(id) => <Select id={id} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} placeholder="None" options={envOptions} />}
              </Field>
            </div>
          </Section>

          <Section title="Build & run">
            {!isImage && (
              <Field label="Runtime" hint="Auto-detect looks for Dockerfile, package.json, requirements.txt, go.mod, Gemfile…">
                {(id) => <Select id={id} className="sm:w-64" value={runtime} onChange={(e) => setRuntime(e.target.value as Runtime)} options={RUNTIMES} />}
              </Field>
            )}
            {!isImage && runtime !== 'docker' && (
              <Field label="Build command" optional>
                {(id) => <Input id={id} mono value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder={type === 'static' ? 'npm ci && npm run build' : 'npm ci && npm run build'} />}
              </Field>
            )}
            {type === 'static' ? (
              <Field label="Publish directory" hint="Directory with the built site, relative to the root directory.">
                {(id) => <Input id={id} mono value={publishPath} onChange={(e) => setPublishPath(e.target.value)} placeholder="dist" />}
              </Field>
            ) : (
              <>
                {runtime !== 'docker' && (
                  <Field label={type === 'cron' ? 'Command' : 'Start command'} optional={type !== 'cron'} hint={type === 'cron' ? 'Runs on each schedule tick.' : 'Leave empty to use the detected default or Procfile.'}>
                    {(id) => <Input id={id} mono value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder={type === 'cron' ? 'node scripts/report.js' : 'npm start'} />}
                  </Field>
                )}
                <Field label="Pre-deploy command" optional hint="Runs once per deploy before instances start — e.g. database migrations.">
                  {(id) => <Input id={id} mono value={preDeployCommand} onChange={(e) => setPreDeployCommand(e.target.value)} placeholder="npm run migrate" />}
                </Field>
              </>
            )}
            {type === 'web' && (
              <Field label="Health check path" optional hint="Must return 2xx/3xx before traffic switches to a new deploy.">
                {(id) => <Input id={id} mono value={healthCheckPath} onChange={(e) => setHealthCheckPath(e.target.value)} placeholder="/healthz" />}
              </Field>
            )}
            {type === 'cron' && (
              <Field label="Schedule (UTC)" error={!cron.valid ? cron.error : null} hint={cron.valid ? <span className="text-accent">{cron.description}</span> : undefined}>
                {(id) => (
                  <div className="space-y-2">
                    <Input id={id} mono value={cronSchedule} onChange={(e) => setCronSchedule(e.target.value)} aria-invalid={!cron.valid} />
                    <div className="flex flex-wrap gap-1.5">
                      {CRON_PRESETS.map((p) => (
                        <button
                          key={p.value}
                          type="button"
                          onClick={() => setCronSchedule(p.value)}
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-xs',
                            cronSchedule === p.value ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:text-fg',
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Field>
            )}
          </Section>

          {type !== 'static' && (
            <Section title="Instance type" description="CPU and memory per instance. You can change this later.">
              <PlanPicker plans={SERVICE_PLANS} value={plan} onChange={setPlan} />
              {needsInstances && (
                <Field label="Instances" hint="Number of instances to run. Enable autoscaling after creation.">
                  {(id) => (
                    <div className="flex items-center gap-3">
                      <input id={id} type="range" min={1} max={10} value={instanceCount} onChange={(e) => setInstanceCount(Number(e.target.value))} className="w-56 accent-[var(--accent)]" />
                      <span className="w-6 font-mono text-[13px]">{instanceCount}</span>
                    </div>
                  )}
                </Field>
              )}
            </Section>
          )}

          <Section title="Environment" description="Variables are encrypted at rest and injected at build and run time. Paste a .env file into a key field to bulk add.">
            <EnvVarEditor value={envVars} onChange={setEnvVars} />
            {(envGroups.data?.items.length ?? 0) > 0 && (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-[13px] font-medium">Link environment groups</p>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {envGroups.data?.items.map((g) => (
                    <Checkbox
                      key={g.id}
                      label={
                        <span>
                          {g.name} <span className="text-fg-subtle">({g.envVars.length})</span>
                        </span>
                      }
                      checked={envGroupIds.includes(g.id)}
                      onChange={(c) => setEnvGroupIds((ids) => (c ? [...ids, g.id] : ids.filter((x) => x !== g.id)))}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-[13px] font-medium">Secret files</p>
              <SecretFilesEditor value={secretFiles} onChange={setSecretFiles} />
            </div>
          </Section>

          <Card>
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((s) => !s)}
            >
              <span className="text-[14px] font-semibold">Advanced</span>
              <ChevronDown className={cn('size-4 text-fg-subtle transition-transform', showAdvanced && 'rotate-180')} />
            </button>
            {showAdvanced && (
              <CardBody className="space-y-5 border-t border-border">
                {!isImage && <Switch checked={autoDeploy} onChange={setAutoDeploy} label="Auto-deploy" description="Deploy automatically on every push to the selected branch." />}
                {hasHttp && (
                  <Field label="Port" optional hint="NAV injects PORT; set this only if your app ignores it.">
                    {(id) => <Input id={id} className="sm:w-40" mono inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="10000" />}
                  </Field>
                )}
                {runtime === 'docker' && !isImage && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Dockerfile path">{(id) => <Input id={id} mono value={dockerfilePath} onChange={(e) => setDockerfilePath(e.target.value)} />}</Field>
                    <Field label="Docker build context">{(id) => <Input id={id} mono value={dockerContext} onChange={(e) => setDockerContext(e.target.value)} />}</Field>
                  </div>
                )}
                {type !== 'static' && type !== 'cron' && (
                  <div className="space-y-3">
                    <Switch checked={diskEnabled} onChange={setDiskEnabled} label="Persistent disk" description="Attach a volume that survives deploys. Services with a disk run a single instance." />
                    {diskEnabled && (
                      <div className="grid gap-4 sm:grid-cols-3">
                        <Field label="Name">{(id) => <Input id={id} mono value={disk.name} onChange={(e) => setDisk({ ...disk, name: e.target.value })} />}</Field>
                        <Field label="Mount path">{(id) => <Input id={id} mono value={disk.mountPath} onChange={(e) => setDisk({ ...disk, mountPath: e.target.value })} />}</Field>
                        <Field label="Size (GB)">
                          {(id) => <Input id={id} type="number" min={1} max={500} value={disk.sizeGB} onChange={(e) => setDisk({ ...disk, sizeGB: Math.max(1, Number(e.target.value) || 1) })} />}
                        </Field>
                      </div>
                    )}
                  </div>
                )}
              </CardBody>
            )}
          </Card>

          <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg/90 px-4 py-3 backdrop-blur md:mx-0 md:rounded-lg md:border">
            {(envError || (type === 'cron' && !cron.valid)) && <span className="mr-auto text-xs text-danger">{envError ?? cron.error}</span>}
            <Button onClick={() => setStep(1)} icon={<ArrowLeft className="size-3.5" />}>
              Back
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!canSubmit}>
              Create {meta.label}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
