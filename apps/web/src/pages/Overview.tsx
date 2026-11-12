import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { ArrowDown, Check, ExternalLink, FileText, MoreHorizontal, Plus, ScrollText, Search, Settings, UserPlus, X } from 'lucide-react';
import type { Database, Deploy, Project, Service } from '@nav/shared';
import { api } from '@/api/client';
import { useDatabases } from '@/api/databases';
import { qk } from '@/api/keys';
import { useServices } from '@/api/services';
import { useProjects } from '@/api/workspaces';
import { RelativeTime } from '@/components/RelativeTime';
import { ResourceIcon, RESOURCE_META, type ResourceKind } from '@/components/ResourceIcon';
import {
  Dropdown,
  DropdownItem,
  Empty,
  ErrorState,
  IconButton,
  Input,
  Segmented,
  SkeletonCard,
  SkeletonRows,
  StatusPill,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { cn } from '@/lib/cn';
import { hostnameOf, repoSlug, titleCase } from '@/lib/format';
import { serviceStatus } from '@/lib/misc';
import { useTitle } from '@/lib/useTitle';
import { Onboarding } from './Onboarding';
import { CreateProjectDialog } from './Projects';

interface Row {
  id: string;
  kind: ResourceKind;
  name: string;
  sub: string;
  status: string;
  runtime: string;
  plan: string;
  environmentId: string | null;
  lastActivity: string | null;
  url: string | null;
  urlLabel: string | null;
  href: string;
}

type StateFilter = 'active' | 'suspended' | 'all';

function serviceRow(ws: string, s: Service, deploy: Deploy | undefined): Row {
  return {
    id: s.id,
    kind: s.type,
    name: s.name,
    sub: s.repoUrl ? `${repoSlug(s.repoUrl)}${s.branch ? ` · ${s.branch}` : ''}` : s.imageUrl ?? s.slug,
    status: serviceStatus(s),
    runtime: s.runtime === 'auto' ? 'Auto' : titleCase(s.runtime),
    plan: s.plan,
    environmentId: s.environmentId,
    lastActivity: deploy ? deploy.finishedAt ?? deploy.createdAt : s.updatedAt,
    url: s.url,
    urlLabel: s.url ? hostnameOf(s.url) : s.internalAddress,
    href: `/w/${ws}/services/${s.id}`,
  };
}

function databaseRow(ws: string, d: Database): Row {
  return {
    id: d.id,
    kind: 'postgres',
    name: d.name,
    sub: `${d.dbName} · ${d.plan}`,
    status: d.status,
    runtime: `PostgreSQL ${d.pgVersion}`,
    plan: d.plan,
    environmentId: d.environmentId,
    lastActivity: d.createdAt,
    url: null,
    urlLabel: null,
    href: `/w/${ws}/databases/${d.id}`,
  };
}

const HEALTHY = new Set(['live', 'available', 'sleeping']);
const FAILING = new Set(['failed', 'build_failed', 'update_failed', 'crashed', 'unhealthy', 'error']);
const BUSY = new Set(['deploying', 'creating', 'restoring', 'created']);

function ProjectHealth({ rows }: { rows: Row[] }) {
  const pill = 'inline-flex h-[24px] items-center gap-1.5 rounded-[3px] px-2 text-[12px] font-medium';
  if (rows.length === 0) return <span className={cn(pill, 'bg-neutral-soft text-fg-muted')}>No services yet</span>;
  const failing = rows.filter((r) => FAILING.has(r.status)).length;
  if (failing) return <span className={cn(pill, 'bg-danger-soft text-danger')}>{failing} service{failing === 1 ? '' : 's'} failing</span>;
  if (rows.some((r) => BUSY.has(r.status))) return <span className={cn(pill, 'bg-warning-soft text-warning')}>Deploying</span>;
  if (rows.every((r) => HEALTHY.has(r.status) || r.status === 'suspended'))
    return (
      <span className={cn(pill, 'bg-success-soft text-success')}>
        <Check className="size-3.5" strokeWidth={2.25} aria-hidden /> All services are up and running
      </span>
    );
  return <span className={cn(pill, 'bg-neutral-soft text-fg-muted')}>{rows.length} resources</span>;
}

function RowMenu({ r }: { r: Row }) {
  const isService = r.kind !== 'postgres';
  return (
    <Dropdown align="end" width="w-48" trigger={(p) => <IconButton {...p} label={`Actions for ${r.name}`} icon={<MoreHorizontal className="size-4" />} />}>
      <DropdownItem icon={<FileText className="size-4" strokeWidth={1.75} />} to={r.href}>
        Open
      </DropdownItem>
      {isService && (
        <DropdownItem icon={<ScrollText className="size-4" strokeWidth={1.75} />} to={`${r.href}/logs`}>
          Logs
        </DropdownItem>
      )}
      <DropdownItem icon={<Settings className="size-4" strokeWidth={1.75} />} to={`${r.href}/settings`}>
        Settings
      </DropdownItem>
      {r.url && (
        <DropdownItem icon={<ExternalLink className="size-4" strokeWidth={1.75} />} onSelect={() => window.open(r.url!, '_blank', 'noopener,noreferrer')}>
          Open URL
        </DropdownItem>
      )}
    </Dropdown>
  );
}

export function OverviewPage() {
  useTitle('Overview');
  const { ws, canWrite } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  const state = (params.get('state') as StateFilter | null) ?? 'active';
  const projectId = params.get('project') ?? '';

  const services = useServices(ws);
  const databases = useDatabases(ws);
  const projects = useProjects(ws);

  // Last deploy time per service (current deploy), cached + invalidated by live updates.
  const deployIds = (services.data?.items ?? []).map((s) => s.currentDeployId).filter((x): x is string => !!x).slice(0, 60);
  const deployQueries = useQueries({
    queries: deployIds.map((id) => ({ queryKey: qk.deploy(id), queryFn: () => api.get<Deploy>(`/deploys/${id}`), staleTime: 60_000 })),
  });
  const deploysById = useMemo(() => {
    const m = new Map<string, Deploy>();
    for (const dq of deployQueries) if (dq.data) m.set(dq.data.id, dq.data);
    return m;
  }, [deployQueries]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const projectList = projects.data?.items ?? [];
  const selectedProject = projectList.find((p) => p.id === projectId);

  const allRows = useMemo<Row[]>(
    () => [
      ...(services.data?.items ?? []).map((s) => serviceRow(ws, s, s.currentDeployId ? deploysById.get(s.currentDeployId) : undefined)),
      ...(databases.data?.items ?? []).map((d) => databaseRow(ws, d)),
    ],
    [services.data, databases.data, deploysById, ws],
  );

  const rowsByProject = useMemo(() => {
    const envToProject = new Map<string, string>();
    for (const p of projectList) for (const e of p.environments) envToProject.set(e.id, p.id);
    const m = new Map<string, Row[]>();
    for (const r of allRows) {
      const pid = r.environmentId ? envToProject.get(r.environmentId) : undefined;
      if (pid) m.set(pid, [...(m.get(pid) ?? []), r]);
    }
    return m;
  }, [allRows, projectList]);

  const scoped = useMemo(() => {
    const projectEnvIds = selectedProject ? new Set(selectedProject.environments.map((e) => e.id)) : null;
    return allRows.filter((r) => !projectEnvIds || (r.environmentId !== null && projectEnvIds.has(r.environmentId)));
  }, [allRows, selectedProject]);

  const counts = useMemo(
    () => ({
      active: scoped.filter((r) => r.status !== 'suspended').length,
      suspended: scoped.filter((r) => r.status === 'suspended').length,
      all: scoped.length,
    }),
    [scoped],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const time = (r: Row) => (r.lastActivity ? Date.parse(r.lastActivity) : 0);
    return scoped
      .filter((r) => (state === 'all' ? true : state === 'suspended' ? r.status === 'suspended' : r.status !== 'suspended'))
      .filter((r) => !needle || `${r.name} ${r.sub} ${r.urlLabel ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
  }, [scoped, q, state]);

  const loading = services.isPending || databases.isPending;
  const error = services.error ?? databases.error;
  const total = allRows.length;
  const empty = !loading && !error && total === 0 && !projects.isPending && projectList.length === 0;

  return (
    <div>
      <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-[22px] leading-[1.2] font-semibold tracking-[-0.02em] text-fg md:text-[26px]">Overview</h1>
        <Link to={`/w/${ws}/settings#members`} className="mt-2 inline-flex items-center gap-1.5 text-[13.5px] text-link hover:underline">
          <UserPlus className="size-4" strokeWidth={1.75} aria-hidden />
          Invite your team
        </Link>
      </div>

      {empty ? (
        <Onboarding />
      ) : (
        <>
          <section aria-labelledby="ov-projects" className="mb-12">
            <h2 id="ov-projects" className="mb-5 text-[18px] font-semibold text-fg">
              Projects
            </h2>
            {projects.isPending ? (
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : projects.isError ? (
              <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {projectList.map((p: Project) => (
                  <Link
                    key={p.id}
                    to={`/w/${ws}?project=${p.id}`}
                    className={cn(
                      'flex min-h-[94px] flex-col justify-between gap-3 rounded-[3px] border p-4 transition-colors hover:bg-surface-2',
                      p.id === projectId ? 'border-accent-strong' : 'border-border-strong',
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[14px] font-semibold text-fg">{p.name}</span>
                      <span className="shrink-0 text-xs text-fg-subtle">
                        {p.environments.length} env{p.environments.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span>
                      <ProjectHealth rows={rowsByProject.get(p.id) ?? []} />
                    </span>
                  </Link>
                ))}
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex min-h-[94px] items-center justify-center gap-2 rounded-[3px] border border-dashed border-border-strong text-[14px] text-fg transition-colors hover:border-fg-subtle hover:bg-surface-2"
                  >
                    <Plus className="size-4" strokeWidth={1.75} aria-hidden /> Create new project
                  </button>
                )}
                {!canWrite && projectList.length === 0 && <p className="text-[13px] text-fg-subtle">No projects yet.</p>}
              </div>
            )}
          </section>

          <section aria-labelledby="ov-services">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 id="ov-services" className="text-[18px] font-semibold text-fg">
                {selectedProject ? `${selectedProject.name} services` : 'Services'}
              </h2>
              {selectedProject && (
                <button
                  type="button"
                  onClick={() => setParam('project', '')}
                  className="inline-flex h-6 items-center gap-1 rounded-[3px] border border-border-strong px-2 text-xs text-fg-muted hover:text-fg"
                  aria-label={`Clear project filter ${selectedProject.name}`}
                >
                  Show all <X className="size-3" />
                </button>
              )}
            </div>
            <div className="mb-4">
              <Segmented<StateFilter>
                label="Filter by state"
                value={state}
                onChange={(v) => setParam('state', v === 'active' ? '' : v)}
                options={[
                  { value: 'active', label: `Active (${counts.active})` },
                  { value: 'suspended', label: `Suspended (${counts.suspended})` },
                  { value: 'all', label: `All (${counts.all})` },
                ]}
              />
            </div>
            <Input
              tall
              className="mb-6 w-full"
              leading={<Search className="size-4" />}
              placeholder="Search services"
              aria-label="Search services"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setParam('q', e.target.value);
              }}
            />

            {loading ? (
              <SkeletonRows rows={4} />
            ) : error ? (
              <ErrorState
                error={error}
                onRetry={() => {
                  void services.refetch();
                  void databases.refetch();
                }}
              />
            ) : rows.length === 0 ? (
              <Empty
                icon={<Search />}
                title={q ? 'No matches' : state === 'suspended' ? 'No suspended services' : 'No services here yet'}
                description={q ? `Nothing matches “${q}”.` : 'Create a service or database with the New menu.'}
                compact
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>
                      <span className="inline-flex items-center gap-2">
                        Service name
                        <span className="rounded-[3px] bg-surface-3 px-1.5 py-px text-[10.5px] text-fg">{rows.length}</span>
                      </span>
                    </Th>
                    <Th>Status</Th>
                    <Th className="hidden md:table-cell">Runtime</Th>
                    <Th className="hidden lg:table-cell">Type</Th>
                    <Th className="hidden sm:table-cell" aria-sort="descending">
                      <span className="inline-flex items-center gap-1">
                        Updated <ArrowDown className="size-3.5" aria-hidden />
                      </span>
                    </Th>
                    <Th className="w-12">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <Tr key={`${r.kind}-${r.id}`} interactive onClick={() => navigate(r.href)}>
                      <Td>
                        <div className="flex min-w-0 items-center gap-2.5" title={r.sub}>
                          <ResourceIcon kind={r.kind} boxed={false} className="text-fg" />
                          <Link
                            to={r.href}
                            className="truncate text-[14px] text-fg underline decoration-fg-subtle underline-offset-[3px] hover:decoration-fg"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.name}
                          </Link>
                          {r.url && (
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="hidden shrink-0 text-fg-subtle hover:text-fg xl:inline-flex"
                              aria-label={`Open ${r.urlLabel ?? r.name}`}
                              title={r.urlLabel ?? undefined}
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <StatusPill status={r.status} />
                      </Td>
                      <Td className="hidden md:table-cell">
                        <span className="inline-flex h-[22px] items-center rounded-[3px] bg-surface-3 px-2 text-[12px] font-medium whitespace-nowrap text-fg">{r.runtime}</span>
                      </Td>
                      <Td className="hidden whitespace-nowrap text-fg lg:table-cell">
                        {RESOURCE_META[r.kind].label}
                        <span className="text-fg-subtle"> · {titleCase(r.plan)}</span>
                      </Td>
                      <Td className="hidden whitespace-nowrap text-fg sm:table-cell">
                        <RelativeTime value={r.lastActivity} />
                      </Td>
                      <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <RowMenu r={r} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </section>
        </>
      )}
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
