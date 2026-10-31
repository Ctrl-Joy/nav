import { useState, type FormEvent } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, ExternalLink, GitBranch, Pause, Play, RefreshCw, Rocket } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useService, useServiceAction, useTriggerDeploy } from '@/api/services';
import { ResourceIcon, RESOURCE_META } from '@/components/ResourceIcon';
import {
  Button,
  Dialog,
  Dropdown,
  DropdownItem,
  Empty,
  ErrorState,
  Field,
  Input,
  RouteTabs,
  Skeleton,
  StatusPill,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { hostnameOf, repoSlug } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import { HAS_URL, type ServiceOutletCtx } from './context';

export function ServiceLayout() {
  const { serviceId = '' } = useParams();
  const { ws, canWrite } = useWorkspace();
  const svc = useService(serviceId);
  const service = svc.data;
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const deploy = useTriggerDeploy(serviceId);
  const action = useServiceAction({ id: serviceId, workspaceId: ws });
  const [shaOpen, setShaOpen] = useState(false);
  const [sha, setSha] = useState('');
  useTitle(service?.name);

  if (svc.isPending) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-72" />
          </div>
        </div>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (svc.isError || !service) {
    if (isApiError(svc.error) && svc.error.isNotFound) {
      return (
        <Empty
          title="Service not found"
          description="It may have been deleted, or it belongs to another workspace."
          action={
            <Link className="text-[13px] font-medium text-accent hover:underline" to={`/w/${ws}`}>
              Back to overview
            </Link>
          }
        />
      );
    }
    return <ErrorState error={svc.error} onRetry={() => svc.refetch()} />;
  }

  const runDeploy = async (body: { clearCache?: boolean; commitSha?: string }) => {
    try {
      const d = await deploy.mutateAsync(body);
      toast.success('Deploy queued', body.clearCache ? 'Build cache will be cleared.' : undefined);
      navigate(`/w/${ws}/services/${service.id}/deploys/${d.id}`);
    } catch (e) {
      toast.fromError(e, 'Could not start deploy');
    }
  };

  const doAction = async (a: 'restart' | 'suspend' | 'resume') => {
    if (a !== 'resume') {
      const ok = await confirm({
        title: a === 'restart' ? `Restart ${service.name}?` : `Suspend ${service.name}?`,
        body:
          a === 'restart'
            ? 'All instances of the live deploy are restarted one at a time.'
            : 'All instances are stopped and requests receive a 503 until you resume.',
        confirmText: a === 'restart' ? 'Restart' : 'Suspend',
        danger: a === 'suspend',
      });
      if (!ok) return;
    }
    try {
      await action.mutateAsync(a);
      toast.success(a === 'restart' ? 'Restart started' : a === 'suspend' ? 'Service suspended' : 'Service resuming');
    } catch (e) {
      toast.fromError(e);
    }
  };

  const submitSha = (e: FormEvent) => {
    e.preventDefault();
    if (!sha.trim()) return;
    setShaOpen(false);
    void runDeploy({ commitSha: sha.trim() });
    setSha('');
  };

  const base = `/w/${ws}/services/${service.id}`;
  const tabs = [
    { to: base, label: 'Events', end: true },
    { to: `${base}/logs`, label: 'Logs' },
    { to: `${base}/metrics`, label: 'Metrics' },
    { to: `${base}/environment`, label: 'Environment' },
    { to: `${base}/scaling`, label: 'Scaling' },
    ...(HAS_URL(service) ? [{ to: `${base}/previews`, label: 'Previews' }] : []),
    { to: `${base}/jobs`, label: service.type === 'cron' ? 'Runs' : 'Jobs' },
    { to: `${base}/settings`, label: 'Settings' },
  ];
  const ctx: ServiceOutletCtx = { service };
  const plan = service.plan;

  return (
    <div>
      {service.parentServiceId && (
        <p className="mb-3 text-xs text-fg-subtle">
          Preview of{' '}
          <Link className="text-accent hover:underline" to={`/w/${ws}/services/${service.parentServiceId}`}>
            parent service
          </Link>
          {service.prNumber ? ` · PR #${service.prNumber}` : ''}
        </p>
      )}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <ResourceIcon kind={service.type} className="size-9" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{service.name}</h1>
              <StatusPill status={service.status} />
              {service.maintenanceMode && <StatusPill status="suspended" label="Maintenance" />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
              <span>{RESOURCE_META[service.type].label}</span>
              {service.repoUrl && (
                <a href={service.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                  <GitBranch className="size-3" />
                  {repoSlug(service.repoUrl)}
                  {service.branch && <span className="font-mono">@{service.branch}</span>}
                </a>
              )}
              {service.imageUrl && <span className="truncate font-mono">{service.imageUrl}</span>}
              <span className="font-mono">{service.runtime}</span>
              <span className="capitalize">{plan.replace('_', ' ')}</span>
              {service.url && (
                <a href={service.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  {hostnameOf(service.url)}
                  <ExternalLink className="size-3" />
                </a>
              )}
              {!service.url && service.internalAddress && <span className="font-mono">{service.internalAddress}</span>}
            </div>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex">
              <Button
                variant="primary"
                className="rounded-r-none"
                icon={<Rocket className="size-3.5" />}
                loading={deploy.isPending}
                onClick={() => runDeploy({})}
              >
                Manual Deploy
              </Button>
              <Dropdown
                align="end"
                width="w-64"
                trigger={(p) => (
                  <Button {...p} variant="primary" aria-label="More deploy options" className="rounded-l-none border-l border-black/15 px-2">
                    <ChevronDown className="size-3.5" />
                  </Button>
                )}
              >
                <DropdownItem onSelect={() => runDeploy({})}>Deploy latest commit</DropdownItem>
                <DropdownItem onSelect={() => runDeploy({ clearCache: true })}>Clear build cache & deploy</DropdownItem>
                <DropdownItem onSelect={() => setShaOpen(true)} disabled={!service.repoUrl}>
                  Deploy a specific commit…
                </DropdownItem>
              </Dropdown>
            </div>
            {!service.suspended && service.type !== 'static' && service.type !== 'cron' && (
              <Button icon={<RefreshCw className="size-3.5" />} onClick={() => doAction('restart')} disabled={action.isPending}>
                Restart
              </Button>
            )}
            {service.suspended ? (
              <Button icon={<Play className="size-3.5" />} onClick={() => doAction('resume')} loading={action.isPending}>
                Resume
              </Button>
            ) : (
              <Button icon={<Pause className="size-3.5" />} onClick={() => doAction('suspend')} disabled={action.isPending}>
                Suspend
              </Button>
            )}
          </div>
        )}
      </div>
      <RouteTabs items={tabs} className="mb-6" label="Service sections" />
      <Outlet context={ctx} />
      <Dialog
        open={shaOpen}
        onClose={() => setShaOpen(false)}
        title="Deploy a specific commit"
        description="NAV will check out this commit and build it."
        footer={
          <>
            <Button onClick={() => setShaOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="deploy-sha" disabled={!sha.trim()}>
              Deploy commit
            </Button>
          </>
        }
      >
        <form id="deploy-sha" onSubmit={submitSha}>
          <Field label="Commit SHA" hint="Full or abbreviated SHA from the service branch history.">
            {(id) => <Input id={id} mono value={sha} onChange={(e) => setSha(e.target.value)} placeholder="a1b2c3d" autoFocus />}
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
