import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, GitBranch } from 'lucide-react';
import type { BlueprintInspection } from '@nav/shared';
import { useMe } from '@/api/auth';
import { useCreateBlueprint, useInspectBlueprint } from '@/api/resources';
import { Logo } from '@/components/Logo';
import { ResourceIcon, type ResourceKind } from '@/components/ResourceIcon';
import { Button, Card, CardBody, CardHeader, CodeBlock, Empty, ErrorState, Field, Input, Select, Skeleton, useToast } from '@/components/ui';
import { FullPageSpinner } from '@/layouts/RootLayout';
import { LAST_WORKSPACE_KEY, readLocal } from '@/lib/misc';
import { repoLabel } from '@/lib/templates';
import { useTitle } from '@/lib/useTitle';

const SERVICE_KINDS: ResourceKind[] = ['web', 'private', 'worker', 'cron', 'static'];

/**
 * "Deploy to NAV": `/deploy?repo=<git url>[&branch=..]`. Signed-out visitors sign up (or in) and come back here;
 * signed-in users review the repository's nav.yaml and create a blueprint from it in one of their workspaces.
 */
export function DeployToNavPage() {
  useTitle('Deploy to NAV');
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageSpinner />;
  if (me.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <ErrorState className="w-full max-w-lg" title="Cannot reach NAV" error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (!me.data) return <Navigate to={`/signup?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <Link to="/app" aria-label="NAV dashboard"><Logo /></Link>
      </header>
      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <DeployReview workspaces={me.data.workspaces} />
      </main>
    </div>
  );
}

function DeployReview({ workspaces }: { workspaces: { id: string; name: string; role: string }[] }) {
  const [params] = useSearchParams();
  const repo = params.get('repo')?.trim() || null;
  const navigate = useNavigate();
  const toast = useToast();

  const writable = workspaces.filter((w) => w.role !== 'viewer');
  const initialWs = useMemo(() => {
    const wanted = params.get('workspace') ?? readLocal(LAST_WORKSPACE_KEY);
    return (writable.find((w) => w.id === wanted) ?? writable[0])?.id ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [ws, setWs] = useState(initialWs);
  const inspect = useInspectBlueprint(repo, params.get('branch'));
  const create = useCreateBlueprint(ws);
  const [name, setName] = useState('');
  useEffect(() => {
    if (inspect.data && !name) setName(inspect.data.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspect.data]);

  if (!repo) {
    return <Empty title="No repository to deploy" description="Deploy links look like /deploy?repo=https://github.com/acme/app." action={<Link to="/app" className="text-[13px] text-accent hover:underline">Go to dashboard</Link>} />;
  }
  if (!writable.length) {
    return <Empty title="No workspace to deploy into" description="You need the developer role or higher in a workspace to create a blueprint." />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!inspect.data?.valid) return;
    try {
      const bp = await create.mutateAsync({ name: name.trim(), repoUrl: inspect.data.repoUrl, branch: inspect.data.branch, filePath: inspect.data.filePath });
      toast.success('Blueprint created', 'Its resources are being created.');
      navigate(`/w/${ws}/blueprints/${bp.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create the blueprint');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <Link to="/app" className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Dashboard
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Deploy to NAV</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
          <span className="font-mono text-xs">{repoLabel(repo)}</span>
          {inspect.data && (
            <span className="inline-flex items-center gap-1 font-mono text-xs"><GitBranch className="size-3" />{inspect.data.branch}</span>
          )}
        </p>
      </div>

      {inspect.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : inspect.isError ? (
        <ErrorState error={inspect.error} title="Could not read this repository" onRetry={() => inspect.refetch()} />
      ) : !inspect.data.valid ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-danger">This repository has no deployable {inspect.data.filePath}</p>
            <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-fg-muted">{inspect.data.errors.join('\n')}</pre>
          </div>
        </div>
      ) : (
        <>
          <Resources data={inspect.data} />
          <Card>
            <CardHeader title="Blueprint" description="NAV keeps these resources in sync with the file on every push." />
            <CardBody className="space-y-4">
              <Field label="Workspace">
                {(id) => <Select id={id} value={ws} onChange={(e) => setWs(e.target.value)} options={writable.map((w) => ({ value: w.id, label: w.name }))} />}
              </Field>
              <Field label="Blueprint name">
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />}
              </Field>
            </CardBody>
          </Card>
          <details className="rounded-lg border border-border">
            <summary className="cursor-pointer px-4 py-2.5 text-[13px] text-fg-muted">View {inspect.data.filePath}</summary>
            <CodeBlock code={inspect.data.yaml} className="rounded-none border-0 border-t" />
          </details>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim() || !ws}>
              Deploy blueprint
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function Resources({ data }: { data: BlueprintInspection }) {
  const rows: { kind: ResourceKind; name: string; detail: string }[] = [
    ...data.services.map((s) => ({ kind: (SERVICE_KINDS as string[]).includes(s.type) ? (s.type as ResourceKind) : 'web', name: s.name, detail: `${s.type} · ${s.runtime}${s.plan ? ` · ${s.plan}` : ''}` })),
    ...data.databases.map((d) => ({ kind: 'postgres' as const, name: d.name, detail: `Postgres${d.plan ? ` · ${d.plan}` : ''}` })),
    ...data.envGroups.map((g) => ({ kind: 'env_group' as const, name: g.name, detail: 'Env group' })),
  ];
  return (
    <Card>
      <CardHeader title="What will be created" description={`${rows.length} resource${rows.length === 1 ? '' : 's'} from ${data.filePath}${data.previews && data.previews.generation !== 'off' ? ', with pull request preview environments' : ''}.`} />
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={`${r.kind}-${r.name}`} className="flex items-center gap-3 px-4 py-2.5">
            <ResourceIcon kind={r.kind} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{r.name}</span>
            <span className="text-xs text-fg-muted">{r.detail}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
