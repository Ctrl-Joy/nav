import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { DATABASE_PLANS } from '@nav/shared';
import { useDatabases } from '@/api/databases';
import { ResourceIcon } from '@/components/ResourceIcon';
import { RelativeTime } from '@/components/RelativeTime';
import { ButtonLink, Empty, ErrorState, Input, PageHeader, SkeletonRows, StatusPill, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';

export function planName(id: string): string {
  return DATABASE_PLANS.find((p) => p.id === id)?.name ?? id;
}

export function DatabasesPage() {
  useTitle('Postgres');
  const { ws, canWrite } = useWorkspace();
  const dbs = useDatabases(ws);
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  const items = useMemo(() => {
    const all = dbs.data?.items ?? [];
    const n = q.trim().toLowerCase();
    return n ? all.filter((d) => `${d.name} ${d.slug} ${d.dbName}`.toLowerCase().includes(n)) : all;
  }, [dbs.data, q]);

  return (
    <div>
      <PageHeader
        icon={<ResourceIcon kind="postgres" boxed={false} />}
        title="Postgres"
        description="Managed PostgreSQL databases with backups, metrics and a query console."
        actions={
          canWrite && (
            <ButtonLink to={`/w/${ws}/databases/new`} variant="primary" icon={<Plus className="size-4" />}>
              New Postgres
            </ButtonLink>
          )
        }
      />
      {(dbs.data?.items.length ?? 0) > 0 && (
        <div className="mb-4 max-w-sm">
          <Input leading={<Search className="size-3.5" />} placeholder="Search databases" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search databases" />
        </div>
      )}
      {dbs.isPending ? (
        <SkeletonRows />
      ) : dbs.isError ? (
        <ErrorState error={dbs.error} onRetry={() => dbs.refetch()} />
      ) : !dbs.data.items.length ? (
        <Empty
          icon={<ResourceIcon kind="postgres" boxed={false} />}
          title="No databases yet"
          description="Spin up a managed PostgreSQL database in seconds. NAV handles provisioning, backups and connection strings."
          action={
            canWrite && (
              <ButtonLink to={`/w/${ws}/databases/new`} variant="primary" icon={<Plus className="size-4" />}>
                Create Postgres
              </ButtonLink>
            )
          }
        />
      ) : !items.length ? (
        <Empty compact title="No matches" description={`No databases match “${q}”.`} />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th className="hidden sm:table-cell">Version</Th>
              <Th className="hidden md:table-cell">Plan</Th>
              <Th className="hidden md:table-cell">Disk</Th>
              <Th className="hidden sm:table-cell">Created</Th>
            </tr>
          </THead>
          <TBody>
            {items.map((d) => (
              <Tr key={d.id} interactive onClick={() => navigate(`/w/${ws}/databases/${d.id}`)}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <ResourceIcon kind="postgres" />
                    <div className="min-w-0">
                      <Link to={`/w/${ws}/databases/${d.id}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                        {d.name}
                      </Link>
                      <div className="font-mono text-[11px] text-fg-subtle">{d.dbName}</div>
                    </div>
                  </div>
                </Td>
                <Td>
                  <StatusPill status={d.status} />
                </Td>
                <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">PG {d.pgVersion}</Td>
                <Td className="hidden text-fg-muted md:table-cell">{planName(d.plan)}</Td>
                <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{d.diskGB} GB</Td>
                <Td className="hidden text-fg-muted sm:table-cell">
                  <RelativeTime value={d.createdAt} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
