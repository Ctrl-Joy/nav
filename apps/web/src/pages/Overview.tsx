import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { ExternalLink, Search } from 'lucide-react';
import type { Database, Deploy, Service } from '@nav/shared';
import { api } from '@/api/client';
import { useDatabases } from '@/api/databases';
import { qk } from '@/api/keys';
import { useServices } from '@/api/services';
import { useProjects } from '@/api/workspaces';
import { RelativeTime } from '@/components/RelativeTime';
import { ResourceIcon, RESOURCE_META, type ResourceKind } from '@/components/ResourceIcon';
import { Empty, ErrorState, Input, PageHeader, Select, SkeletonRows, StatusPill, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { NewMenu } from '@/layouts/NewMenu';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { hostnameOf, repoSlug, titleCase } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import { Onboarding } from './Onboarding';

interface Row {
  id: string;
  kind: ResourceKind;
  name: string;
  sub: string;
  status: string;
  runtime: string;
  environmentId: string | null;
  lastActivity: string | null;
  url: string | null;
  urlLabel: string | null;
  href: string;
}

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  ...(['web', 'private', 'worker', 'cron', 'static', 'postgres'] as ResourceKind[]).map((k) => ({ value: k, label: RESOURCE_META[k].label })),
];

function serviceRow(ws: string, s: Service, deploy: Deploy | undefined): Row {
  return {
    id: s.id,
    kind: s.type,
    name: s.name,
    sub: s.repoUrl ? `${repoSlug(s.repoUrl)}${s.branch ? ` · ${s.branch}` : ''}` : s.imageUrl ?? s.slug,
    status: s.status,
    runtime: s.runtime === 'auto' ? 'Auto' : titleCase(s.runtime),
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
    environmentId: d.environmentId,
    lastActivity: d.createdAt,
    url: null,
    urlLabel: null,
    href: `/w/${ws}/databases/${d.id}`,
  };
}

export function OverviewPage() {
  useTitle('Overview');
  const { ws, canWrite, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const type = params.get('type') ?? '';
  const projectId = params.get('project') ?? '';
  const envId = params.get('env') ?? '';

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
    if (key === 'project') next.delete('env');
    setParams(next, { replace: true });
  };

  const projectList = projects.data?.items ?? [];
  const selectedProject = projectList.find((p) => p.id === projectId);
  const envNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectList) for (const e of p.environments) m.set(e.id, `${p.name} / ${e.name}`);
    return m;
  }, [projectList]);

  const rows = useMemo(() => {
    const all: Row[] = [
      ...(services.data?.items ?? []).map((s) => serviceRow(ws, s, s.currentDeployId ? deploysById.get(s.currentDeployId) : undefined)),
      ...(databases.data?.items ?? []).map((d) => databaseRow(ws, d)),
    ];
    const needle = q.trim().toLowerCase();
    const projectEnvIds = selectedProject ? new Set(selectedProject.environments.map((e) => e.id)) : null;
    return all
      .filter((r) => !type || r.kind === type)
      .filter((r) => !projectEnvIds || (r.environmentId !== null && projectEnvIds.has(r.environmentId)))
      .filter((r) => !envId || r.environmentId === envId)
      .filter((r) => !needle || `${r.name} ${r.sub} ${r.urlLabel ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [services.data, databases.data, deploysById, ws, q, type, selectedProject, envId]);

  const loading = services.isPending || databases.isPending;
  const error = services.error ?? databases.error;
  const total = (services.data?.items.length ?? 0) + (databases.data?.items.length ?? 0);
  const filtered = !!(q || type || projectId || envId);

  return (
    <div>
      <PageHeader title="Overview" description={`Services and databases in ${workspace.name}`} actions={canWrite && <NewMenu ws={ws} />} />

      {!loading && !error && total === 0 ? (
        <Onboarding />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-64"
              leading={<Search className="size-3.5" />}
              placeholder="Search by name, repo or URL"
              aria-label="Search resources"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setParam('q', e.target.value);
              }}
            />
            <Select aria-label="Filter by type" className="w-44" value={type} onChange={(e) => setParam('type', e.target.value)} options={TYPE_FILTERS} />
            <Select
              aria-label="Filter by project"
              className="w-44"
              value={projectId}
              onChange={(e) => setParam('project', e.target.value)}
              placeholder="All projects"
              options={projectList.map((p) => ({ value: p.id, label: p.name }))}
            />
            {selectedProject && (
              <Select
                aria-label="Filter by environment"
                className="w-44"
                value={envId}
                onChange={(e) => setParam('env', e.target.value)}
                placeholder="All environments"
                options={selectedProject.environments.map((e) => ({ value: e.id, label: e.name }))}
              />
            )}
            {filtered && (
              <button type="button" className="text-[13px] text-fg-muted hover:text-fg" onClick={() => { setQ(''); setParams({}, { replace: true }); }}>
                Clear filters
              </button>
            )}
            <span className="ml-auto text-xs text-fg-subtle">{rows.length} of {total}</span>
          </div>

          {loading ? (
            <SkeletonRows rows={6} />
          ) : error ? (
            <ErrorState error={error} onRetry={() => { void services.refetch(); void databases.refetch(); }} />
          ) : rows.length === 0 ? (
            <Empty icon={<Search className="size-4" />} title="No matches" description="Nothing matches these filters." compact />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th className="hidden md:table-cell">Runtime</Th>
                  <Th className="hidden lg:table-cell">Environment</Th>
                  <Th className="hidden sm:table-cell">Last deploy</Th>
                  <Th className="hidden md:table-cell">URL</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={`${r.kind}-${r.id}`} interactive onClick={() => navigate(r.href)}>
                    <Td>
                      <div className="flex min-w-0 items-center gap-3">
                        <ResourceIcon kind={r.kind} />
                        <div className="min-w-0">
                          <Link to={r.href} className="block truncate font-medium text-fg hover:text-accent" onClick={(e) => e.stopPropagation()}>
                            {r.name}
                          </Link>
                          <div className="max-w-[16rem] truncate text-xs text-fg-subtle">
                            {RESOURCE_META[r.kind].label} · {r.sub}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <StatusPill status={r.status} />
                    </Td>
                    <Td className="hidden text-fg-muted md:table-cell">{r.runtime}</Td>
                    <Td className="hidden text-fg-muted lg:table-cell">{r.environmentId ? envNames.get(r.environmentId) ?? '—' : '—'}</Td>
                    <Td className="hidden text-fg-muted sm:table-cell">
                      <RelativeTime value={r.lastActivity} />
                    </Td>
                    <Td className="hidden md:table-cell">
                      {r.url ? (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex max-w-[14rem] items-center gap-1 truncate font-mono text-xs text-fg-muted hover:text-accent"
                        >
                          <span className="truncate">{r.urlLabel}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      ) : r.urlLabel ? (
                        <span className="font-mono text-xs text-fg-subtle">{r.urlLabel}</span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
