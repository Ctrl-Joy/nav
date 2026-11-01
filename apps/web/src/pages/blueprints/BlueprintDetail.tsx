import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink, GitPullRequest, RefreshCw, Trash2 } from 'lucide-react';
import type { Blueprint, BlueprintPreviews, PreviewEnvironment } from '@nav/shared';
import { isApiError } from '@/api/client';
import { useBlueprint, useBlueprintPreviews, useDeleteBlueprint, useDeleteBlueprintPreview, useSyncBlueprint, useUpdateBlueprint } from '@/api/resources';
import { ResourceIcon, type ResourceKind } from '@/components/ResourceIcon';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Button, Card, CardBody, CardFooter, CardHeader, Checkbox, Dialog, Empty, ErrorState, Field, Input, PageHeader, Segmented, Skeleton, SkeletonRows,
  StatusPill, Switch, Table, TBody, Td, Th, THead, Tr, useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { hostnameOf, repoSlug } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';

type Resource = Blueprint['resources'][number];

function resourceKind(r: Resource): ResourceKind {
  return r.type === 'database' ? 'postgres' : r.type === 'env_group' ? 'env_group' : 'web';
}

function resourcePath(ws: string, r: Resource): string {
  if (r.type === 'database') return `/w/${ws}/databases/${r.id}`;
  if (r.type === 'env_group') return `/w/${ws}/env-groups/${r.id}`;
  return `/w/${ws}/services/${r.id}`;
}

const TYPE_LABEL: Record<Resource['type'], string> = { service: 'Service', database: 'Postgres', env_group: 'Env Group' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border px-4 py-3 last:border-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center">
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-fg">{children}</dd>
    </div>
  );
}

const PREVIEW_STATUS: Record<PreviewEnvironment['status'], string> = { creating: 'deploying', ready: 'live', failed: 'failed', deleting: 'deleting' };

/** Blueprint preview environments: settings (also settable in nav.yaml) and the live list per pull request. */
function BlueprintPreviewsCard({ blueprint: b }: { blueprint: Blueprint }) {
  const { ws, canWrite } = useWorkspace();
  const toast = useToast();
  const update = useUpdateBlueprint(ws, b.id);
  const previews = useBlueprintPreviews(b.id);
  const del = useDeleteBlueprintPreview(b.id);
  const [cfg, setCfg] = useState<BlueprintPreviews>(b.previews);
  useEffect(() => setCfg(b.previews), [b.previews]);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(b.previews);
  const [confirm, setConfirm] = useState<PreviewEnvironment | null>(null);

  const save = async () => {
    try {
      await update.mutateAsync({ previews: cfg });
      toast.success('Preview settings saved');
    } catch (e) {
      toast.fromError(e, 'Could not update blueprint');
    }
  };

  const onDelete = async () => {
    if (!confirm) return;
    try {
      await del.mutateAsync(confirm.id);
      toast.success(`Preview for PR #${confirm.prNumber} deleted`, 'Its services, databases and env groups are being deleted.');
      setConfirm(null);
    } catch (e) {
      toast.fromError(e, 'Could not delete preview environment');
    }
  };

  const repoHref = /^https?:\/\//.test(b.repoUrl) ? b.repoUrl.replace(/\.git$/, '') : null;

  return (
    <Card>
      <CardHeader
        title="Preview environments"
        description={`A copy of every resource in this blueprint for each pull request against ${b.branch}, deleted when the PR closes. Set "previews:" in ${b.filePath} to manage this from the file.`}
      />
      <CardBody className="space-y-4">
        <Segmented
          label="Generation"
          value={cfg.generation}
          onChange={(generation) => setCfg({ ...cfg, generation })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'manual', label: 'Manual' },
            { value: 'automatic', label: 'Automatic' },
          ]}
        />
        <p className="text-xs text-fg-subtle">
          {cfg.generation === 'automatic'
            ? 'Every pull request gets a preview environment.'
            : cfg.generation === 'manual'
              ? 'Add the nav-preview label to a pull request to create its preview environment.'
              : 'No preview environments are created.'}
        </p>
        <Field label="Expire after (days)" hint="Preview environments without pull request activity are deleted after this many days. 0 keeps them until the PR closes." className="max-w-xs">
          {(id) => (
            <Input id={id} type="number" min={0} max={365} value={cfg.expireAfterDays} disabled={!canWrite || cfg.generation === 'off'}
              onChange={(e) => setCfg({ ...cfg, expireAfterDays: Math.max(0, Number(e.target.value) || 0) })} />
          )}
        </Field>
      </CardBody>
      {canWrite && (
        <CardFooter>
          <Button variant="primary" size="sm" disabled={!dirty} loading={update.isPending} onClick={save}>
            Save
          </Button>
        </CardFooter>
      )}
      <div className="border-t border-border p-4">
        {previews.isPending ? (
          <SkeletonRows rows={2} />
        ) : previews.isError ? (
          <ErrorState error={previews.error} onRetry={() => previews.refetch()} />
        ) : !previews.data.items.length ? (
          <Empty compact icon={<GitPullRequest className="size-5" />} title="No preview environments" description="Open a pull request against the blueprint branch." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Pull request</Th>
                <Th>Status</Th>
                <Th>Resources</Th>
                <Th>Updated</Th>
                <Th />
              </tr>
            </THead>
            <TBody>
              {previews.data.items.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <div className="font-medium text-fg">
                      {repoHref ? (
                        <a href={`${repoHref}/pull/${p.prNumber}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                          #{p.prNumber} <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        `#${p.prNumber}`
                      )}{' '}
                      <span className="font-normal text-fg-muted">{p.prTitle}</span>
                    </div>
                    <div className="font-mono text-xs text-fg-subtle">{p.branch}{p.commitSha ? ` @ ${p.commitSha.slice(0, 7)}` : ''}</div>
                    {p.error && <div className="mt-1 text-xs break-words text-danger">{p.error}</div>}
                  </Td>
                  <Td><StatusPill status={PREVIEW_STATUS[p.status]} /></Td>
                  <Td>
                    <ul className="space-y-1">
                      {p.resources.map((r) => (
                        <li key={`${r.type}-${r.id}`} className="flex flex-wrap items-center gap-2 text-[13px]">
                          <Link to={resourcePath(ws, r)} className="flex items-center gap-1.5 text-fg hover:underline">
                            <ResourceIcon kind={resourceKind(r)} />
                            {r.name}
                          </Link>
                          {r.url && (
                            <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline">
                              {hostnameOf(r.url)} <ExternalLink className="size-3" />
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Td>
                  <Td className="text-fg-muted"><RelativeTime value={p.updatedAt} /></Td>
                  <Td className="text-right">
                    {canWrite && (
                      <Button size="sm" variant="outline-danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(p)}>
                        Delete
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Delete the preview for PR #${confirm?.prNumber ?? ''}?`}
        description="Its services, databases (with their data) and env groups are deleted. Pushing to the PR again recreates it."
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" loading={del.isPending} onClick={onDelete}>
              Delete preview
            </Button>
          </>
        }
      />
    </Card>
  );
}

export function BlueprintDetailPage() {
  const { blueprintId = '' } = useParams();
  const { ws, canWrite, isAdmin } = useWorkspace();
  const bp = useBlueprint(blueprintId);
  const sync = useSyncBlueprint(ws, blueprintId);
  const update = useUpdateBlueprint(ws, blueprintId);
  const del = useDeleteBlueprint(ws);
  const toast = useToast();
  const navigate = useNavigate();
  const [delOpen, setDelOpen] = useState(false);
  const [deleteResources, setDeleteResources] = useState(false);
  useTitle(bp.data?.name ?? 'Blueprint');

  if (bp.isPending) return <Skeleton className="h-64 w-full" />;
  if (bp.isError) {
    if (isApiError(bp.error) && bp.error.isNotFound) {
      return <Empty title="Blueprint not found" action={<Link to={`/w/${ws}/blueprints`} className="text-[13px] text-accent hover:underline">Back to Blueprints</Link>} />;
    }
    return <ErrorState error={bp.error} onRetry={() => bp.refetch()} />;
  }
  const b = bp.data;
  const busy = b.status === 'syncing' || b.status === 'pending';

  const onSync = async () => {
    try {
      await sync.mutateAsync();
      toast.success('Sync started');
    } catch (e) {
      toast.fromError(e, 'Could not start sync');
    }
  };

  const onAutoSync = async (v: boolean) => {
    try {
      await update.mutateAsync({ autoSync: v });
      toast.success(v ? 'Auto-sync enabled' : 'Auto-sync disabled');
    } catch (e) {
      toast.fromError(e, 'Could not update blueprint');
    }
  };

  const onDelete = async () => {
    try {
      await del.mutateAsync({ id: b.id, deleteResources });
      toast.success('Blueprint deleted', deleteResources ? 'Managed resources are being deleted.' : 'Managed resources were kept.');
      navigate(`/w/${ws}/blueprints`);
    } catch (e) {
      toast.fromError(e, 'Could not delete blueprint');
    }
  };

  const repoHref = /^https?:\/\//.test(b.repoUrl) ? b.repoUrl.replace(/\.git$/, '') : null;

  return (
    <div className="space-y-5">
      <Link to={`/w/${ws}/blueprints`} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Blueprints
      </Link>
      <PageHeader
        icon={<ResourceIcon kind="blueprint" boxed={false} />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {b.name} <StatusPill status={b.status} />
          </span>
        }
        description={
          <>
            {repoSlug(b.repoUrl)} · {b.branch} · {b.filePath}
          </>
        }
        actions={
          canWrite && (
            <Button variant="primary" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending} disabled={busy} onClick={onSync}>
              {busy ? 'Syncing…' : 'Manual sync'}
            </Button>
          )
        }
      />

      {b.status === 'error' && b.lastError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-danger">Last sync failed</p>
            <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-fg-muted">{b.lastError}</pre>
          </div>
        </div>
      )}

      <Card>
        <CardHeader title="Configuration" />
        <dl>
          <Row label="Repository">
            {repoHref ? (
              <a href={repoHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline">
                {repoSlug(b.repoUrl)} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="font-mono text-xs">{b.repoUrl}</span>
            )}
          </Row>
          <Row label="Branch">
            <span className="font-mono text-xs">{b.branch}</span>
          </Row>
          <Row label="File">
            <span className="font-mono text-xs">{b.filePath}</span>
          </Row>
          <Row label="Last synced">{b.lastSyncedAt ? <RelativeTime value={b.lastSyncedAt} /> : 'Never'}</Row>
          <Row label="Auto-sync">
            <Switch
              checked={b.autoSync}
              onChange={onAutoSync}
              disabled={!canWrite || update.isPending}
              label={b.autoSync ? 'On' : 'Off'}
              description="Re-sync automatically on every push to the branch."
            />
          </Row>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Managed resources" description="Resources created and kept in sync by this blueprint." />
        <div className="p-4">
          {b.resources.length === 0 ? (
            <Empty compact title="No resources yet" description={busy ? 'The sync is still running.' : 'Sync the blueprint to create the resources defined in the file.'} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                </tr>
              </THead>
              <TBody>
                {b.resources.map((r) => (
                  <Tr key={`${r.type}-${r.id}`}>
                    <Td>
                      <Link to={resourcePath(ws, r)} className="flex items-center gap-2.5 font-medium text-fg hover:underline">
                        <ResourceIcon kind={resourceKind(r)} />
                        {r.name}
                      </Link>
                    </Td>
                    <Td className="text-fg-muted">{TYPE_LABEL[r.type]}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </Card>

      <BlueprintPreviewsCard blueprint={b} />

      {isAdmin && (
        <Card className="border-danger/40">
          <CardHeader
            title={<span className="text-danger">Danger zone</span>}
            description="Delete this blueprint. You can keep or delete the resources it manages."
            actions={
              <Button variant="outline-danger" icon={<Trash2 className="size-3.5" />} onClick={() => setDelOpen(true)}>
                Delete blueprint
              </Button>
            }
          />
        </Card>
      )}

      <Dialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title={`Delete ${b.name}?`}
        description="The blueprint stops syncing. This cannot be undone."
        footer={
          <>
            <Button onClick={() => setDelOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={del.isPending} onClick={onDelete}>
              Delete blueprint
            </Button>
          </>
        }
      >
        <Checkbox checked={deleteResources} onChange={setDeleteResources} label={`Also delete the ${b.resources.length} managed resource${b.resources.length === 1 ? '' : 's'}`} />
        {deleteResources && (
          <p className="mt-2 text-xs text-danger">Services, databases (including their data) and env groups created by this blueprint will be permanently deleted.</p>
        )}
      </Dialog>
    </div>
  );
}
