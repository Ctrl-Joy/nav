import { Camera, HardDrive, RotateCcw } from 'lucide-react';
import { useCreateSnapshot, useDiskSnapshots, useRestoreSnapshot } from '@/api/services';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorState,
  SettingRow,
  SkeletonRows,
  StatusPill,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatBytes } from '@/lib/format';
import { formatDateTime } from '@/lib/time';
import { useServiceCtx } from './context';

export function ServiceDisksTab() {
  const { service } = useServiceCtx();
  const { canWrite, isAdmin } = useWorkspace();
  const snaps = useDiskSnapshots(service.id, !!service.disk);
  const create = useCreateSnapshot(service.id);
  const restore = useRestoreSnapshot(service.id);
  const confirm = useConfirm();
  const toast = useToast();
  const disk = service.disk;
  if (!disk) return <Empty icon={<HardDrive />} title="No persistent disk" description="This service has no disk attached." />;
  const busy = snaps.data?.items.some((s) => s.status === 'pending' || s.status === 'restoring') ?? false;

  const onCreate = async () => {
    try {
      await create.mutateAsync();
      toast.success('Snapshot started');
    } catch (e) {
      toast.fromError(e, 'Could not take snapshot');
    }
  };

  const onRestore = async (id: string, createdAt: string) => {
    const ok = await confirm({
      title: 'Restore this snapshot?',
      body: (
        <p>
          {service.name} restarts and the contents of <code className="font-mono text-fg">{disk.mountPath}</code> are replaced with the snapshot from{' '}
          <strong className="text-fg">{formatDateTime(createdAt)}</strong>. Anything written since then is lost.
        </p>
      ),
      typeToConfirm: service.name,
      confirmText: 'Restore',
      danger: true,
    });
    if (!ok) return;
    try {
      await restore.mutateAsync(id);
      toast.success('Restore started', 'The service restarts once the disk is restored.');
    } catch (e) {
      toast.fromError(e, 'Could not restore snapshot');
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Disk" />
        <SettingRow title="Name">
          <span className="font-mono text-[13px]">{disk.name}</span>
        </SettingRow>
        <SettingRow title="Mount path">
          <span className="font-mono text-[13px]">{disk.mountPath}</span>
        </SettingRow>
        <SettingRow title="Size">{disk.sizeGB} GB</SettingRow>
      </Card>
      <Card>
        <CardHeader
          title="Snapshots"
          description="NAV snapshots the disk daily. Take a manual snapshot before risky changes."
          actions={
            canWrite && (
              <Button size="sm" variant="primary" icon={<Camera className="size-3.5" />} loading={create.isPending} disabled={busy} onClick={onCreate}>
                Take snapshot
              </Button>
            )
          }
        />
        <CardBody>
          {snaps.isPending ? (
            <SkeletonRows rows={3} />
          ) : snaps.isError ? (
            <ErrorState error={snaps.error} onRetry={() => snaps.refetch()} />
          ) : !snaps.data.items.length ? (
            <Empty compact icon={<HardDrive className="size-4" />} title="No snapshots yet" description="The first automatic snapshot runs within a day." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Created</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th className="hidden sm:table-cell">Size</Th>
                  <Th className="hidden md:table-cell">Finished</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {snaps.data.items.map((s) => (
                  <Tr key={s.id}>
                    <Td>
                      <span title={formatDateTime(s.createdAt)}>
                        <RelativeTime value={s.createdAt} />
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={s.kind === 'manual' ? 'accent' : 'neutral'}>{s.kind}</Badge>
                    </Td>
                    <Td>
                      <StatusPill status={s.status} />
                      {s.error && <p className="mt-1 max-w-[36ch] truncate text-xs text-danger" title={s.error}>{s.error}</p>}
                    </Td>
                    <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">{formatBytes(s.sizeBytes)}</Td>
                    <Td className="hidden text-fg-muted md:table-cell">{s.finishedAt ? <RelativeTime value={s.finishedAt} /> : '—'}</Td>
                    <Td>
                      <div className="flex justify-end">
                        {isAdmin && s.status === 'completed' && (
                          <Button size="sm" icon={<RotateCcw className="size-3.5" />} disabled={restore.isPending || busy} onClick={() => onRestore(s.id, s.createdAt)}>
                            Restore
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
