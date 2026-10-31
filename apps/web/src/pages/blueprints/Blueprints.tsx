import { Link, useNavigate } from 'react-router-dom';
import { GitBranch, Plus } from 'lucide-react';
import { useBlueprints } from '@/api/resources';
import { ResourceIcon } from '@/components/ResourceIcon';
import { RelativeTime } from '@/components/RelativeTime';
import { ButtonLink, Empty, ErrorState, PageHeader, SkeletonRows, StatusPill, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { repoSlug } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import { YamlValidator } from './YamlValidator';

export function BlueprintsPage() {
  useTitle('Blueprints');
  const { ws, canWrite } = useWorkspace();
  const bps = useBlueprints(ws);
  const navigate = useNavigate();

  const newBtn = canWrite && (
    <ButtonLink to={`/w/${ws}/blueprints/new`} variant="primary" icon={<Plus className="size-4" />}>
      New Blueprint Instance
    </ButtonLink>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<ResourceIcon kind="blueprint" boxed={false} />}
        title="Blueprints"
        description="Infrastructure as code: describe services, databases and env groups in nav.yaml and NAV keeps them in sync."
        actions={newBtn}
      />
      {bps.isPending ? (
        <SkeletonRows rows={3} />
      ) : bps.isError ? (
        <ErrorState error={bps.error} onRetry={() => bps.refetch()} />
      ) : !bps.data.items.length ? (
        <Empty
          icon={<ResourceIcon kind="blueprint" boxed={false} />}
          title="No blueprints yet"
          description="Commit a nav.yaml to your repository and connect it here. Every push to the branch re-syncs your infrastructure."
          action={newBtn}
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th className="hidden md:table-cell">Repository</Th>
              <Th className="hidden lg:table-cell">File</Th>
              <Th>Status</Th>
              <Th className="hidden sm:table-cell">Last synced</Th>
              <Th className="hidden sm:table-cell">Resources</Th>
            </tr>
          </THead>
          <TBody>
            {bps.data.items.map((b) => (
              <Tr key={b.id} interactive onClick={() => navigate(`/w/${ws}/blueprints/${b.id}`)}>
                <Td>
                  <Link to={`/w/${ws}/blueprints/${b.id}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                    {b.name}
                  </Link>
                </Td>
                <Td className="hidden md:table-cell">
                  <span className="font-mono text-xs text-fg-muted">{repoSlug(b.repoUrl)}</span>
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-fg-subtle">
                    <GitBranch className="size-3" />
                    {b.branch}
                  </span>
                </Td>
                <Td className="hidden font-mono text-xs text-fg-muted lg:table-cell">{b.filePath}</Td>
                <Td>
                  <StatusPill status={b.status} />
                </Td>
                <Td className="hidden text-fg-muted sm:table-cell">{b.lastSyncedAt ? <RelativeTime value={b.lastSyncedAt} /> : 'Never'}</Td>
                <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">{b.resources.length}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <YamlValidator />
    </div>
  );
}
