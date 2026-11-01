import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, Plus } from 'lucide-react';
import { useWorkflows } from '@/api/workflows';
import { ResourceIcon } from '@/components/ResourceIcon';
import { RelativeTime } from '@/components/RelativeTime';
import { ButtonLink, Empty, ErrorState, PageHeader, SkeletonRows, StatusPill, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { serviceStatus } from '@/lib/misc';
import { useTitle } from '@/lib/useTitle';

export function WorkflowsPage() {
  useTitle('Workflows');
  const { ws, canWrite } = useWorkspace();
  const workflows = useWorkflows(ws);
  const navigate = useNavigate();
  const newButton = canWrite && (
    <ButtonLink to={`/w/${ws}/new/workflow`} variant="primary" icon={<Plus className="size-4" />}>
      New Workflow
    </ButtonLink>
  );

  return (
    <div>
      <PageHeader
        icon={<ResourceIcon kind="workflow" boxed={false} />}
        title="Workflows"
        description="Durable background tasks defined in your code: automatic retries, timeouts, subtasks and fan-out."
        actions={newButton}
      />
      {workflows.isPending ? (
        <SkeletonRows />
      ) : workflows.isError ? (
        <ErrorState error={workflows.error} onRetry={() => workflows.refetch()} />
      ) : !workflows.data.items.length ? (
        <Empty
          icon={<ResourceIcon kind="workflow" boxed={false} />}
          title="No workflows yet"
          description="Register tasks with the @nav/workflows SDK in a repository, then create a Workflow from it. NAV discovers the tasks on every deploy."
          action={
            <>
              {newButton}
              <ButtonLink to="/docs#workflows" icon={<BookOpen className="size-4" />}>
                Read the docs
              </ButtonLink>
            </>
          }
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Tasks</Th>
              <Th>Active runs</Th>
              <Th className="hidden md:table-cell">Failed</Th>
              <Th className="hidden sm:table-cell">Updated</Th>
            </tr>
          </THead>
          <TBody>
            {workflows.data.items.map((w) => {
              const to = `/w/${ws}/services/${w.service.id}/runs`;
              const active = w.counts.queued + w.counts.running + w.counts.waiting;
              return (
                <Tr key={w.service.id} interactive onClick={() => navigate(to)}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <ResourceIcon kind="workflow" />
                      <div className="min-w-0">
                        <Link to={to} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                          {w.service.name}
                        </Link>
                        <div className="font-mono text-[11px] text-fg-subtle">{w.service.slug}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <StatusPill status={serviceStatus(w.service)} />
                  </Td>
                  <Td className="hidden max-w-80 truncate font-mono text-xs text-fg-muted md:table-cell">
                    {w.tasks.length ? w.tasks.map((t) => t.name).join(', ') : '—'}
                  </Td>
                  <Td className="text-fg-muted">{active ? `${w.counts.running} running · ${w.counts.waiting} waiting · ${w.counts.queued} queued` : '—'}</Td>
                  <Td className={w.counts.failed ? 'hidden text-danger md:table-cell' : 'hidden text-fg-muted md:table-cell'}>{w.counts.failed}</Td>
                  <Td className="hidden text-fg-muted sm:table-cell">
                    <RelativeTime value={w.service.updatedAt} />
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
