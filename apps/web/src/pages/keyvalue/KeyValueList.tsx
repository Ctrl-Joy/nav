import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useKeyValues } from '@/api/keyvalue';
import { ResourceIcon } from '@/components/ResourceIcon';
import { RelativeTime } from '@/components/RelativeTime';
import { ButtonLink, Empty, ErrorState, Input, PageHeader, SkeletonRows, StatusPill, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useTitle } from '@/lib/useTitle';
import { kvPlanName } from './context';

export function KeyValueListPage() {
  useTitle('Key Value');
  const { ws, canWrite } = useWorkspace();
  const kvs = useKeyValues(ws);
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  const items = useMemo(() => {
    const all = kvs.data?.items ?? [];
    const n = q.trim().toLowerCase();
    return n ? all.filter((k) => `${k.name} ${k.slug}`.toLowerCase().includes(n)) : all;
  }, [kvs.data, q]);

  return (
    <div>
      <PageHeader
        icon={<ResourceIcon kind="keyvalue" boxed={false} />}
        title="Key Value"
        description="Managed Redis-compatible instances for caching, queues and session storage."
        actions={
          canWrite && (
            <ButtonLink to={`/w/${ws}/key-value/new`} variant="primary" icon={<Plus className="size-4" />}>
              New Key Value
            </ButtonLink>
          )
        }
      />
      {(kvs.data?.items.length ?? 0) > 0 && (
        <div className="mb-4 max-w-sm">
          <Input leading={<Search className="size-3.5" />} placeholder="Search Key Value instances" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Key Value instances" />
        </div>
      )}
      {kvs.isPending ? (
        <SkeletonRows />
      ) : kvs.isError ? (
        <ErrorState error={kvs.error} onRetry={() => kvs.refetch()} />
      ) : !kvs.data.items.length ? (
        <Empty
          icon={<ResourceIcon kind="keyvalue" boxed={false} />}
          title="No Key Value instances yet"
          description="Create a Redis-compatible store in seconds. Services in this workspace connect over the private network."
          action={
            canWrite && (
              <ButtonLink to={`/w/${ws}/key-value/new`} variant="primary" icon={<Plus className="size-4" />}>
                Create Key Value
              </ButtonLink>
            )
          }
        />
      ) : !items.length ? (
        <Empty compact title="No matches" description={`No Key Value instances match “${q}”.`} />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Plan</Th>
              <Th className="hidden md:table-cell">Eviction</Th>
              <Th className="hidden sm:table-cell">Created</Th>
            </tr>
          </THead>
          <TBody>
            {items.map((k) => (
              <Tr key={k.id} interactive onClick={() => navigate(`/w/${ws}/key-value/${k.id}`)}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <ResourceIcon kind="keyvalue" />
                    <div className="min-w-0">
                      <Link to={`/w/${ws}/key-value/${k.id}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                        {k.name}
                      </Link>
                      <div className="font-mono text-[11px] text-fg-subtle">{k.slug}</div>
                    </div>
                  </div>
                </Td>
                <Td>
                  <StatusPill status={k.status} />
                </Td>
                <Td className="hidden text-fg-muted md:table-cell">{kvPlanName(k.plan)}</Td>
                <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{k.maxmemoryPolicy}</Td>
                <Td className="hidden text-fg-muted sm:table-cell">
                  <RelativeTime value={k.createdAt} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
