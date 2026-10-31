import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink, GitPullRequest, Plus } from 'lucide-react';
import type { Previews } from '@nav/shared';
import { useBranches } from '@/api/workspaces';
import { useCreatePreview, usePreviews, useUpdateService } from '@/api/services';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Input,
  Segmented,
  Select,
  SkeletonRows,
  StatusPill,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { hostnameOf } from '@/lib/format';
import { HAS_URL, useServiceCtx } from './context';

export function ServicePreviewsTab() {
  const { service } = useServiceCtx();
  const { ws, canWrite } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const update = useUpdateService(service);
  const previews = usePreviews(service.id);
  const create = useCreatePreview(service.id);
  const branches = useBranches(service.repoUrl);

  const [cfg, setCfg] = useState<Previews>(service.previews);
  useEffect(() => setCfg(service.previews), [service.previews]);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(service.previews);

  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState('');
  const [pr, setPr] = useState('');

  if (!HAS_URL(service)) {
    return <Empty title="Previews are for web services and static sites" description="Preview environments spin up a copy of your service per pull request." />;
  }

  const save = async () => {
    try {
      await update.mutateAsync({ previews: cfg });
      toast.success('Preview settings saved');
    } catch (e) {
      toast.fromError(e);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await create.mutateAsync({ branch: branch.trim(), prNumber: pr ? Number(pr) : undefined });
      toast.success('Preview created', `Deploying ${branch}`);
      setOpen(false);
      navigate(`/w/${ws}/services/${res.service.id}/deploys/${res.deploy.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not create preview');
    }
  };

  const branchList = branches.data?.items ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Preview environments" description="Each pull request gets its own copy of this service with a unique URL, torn down when the PR closes." />
        <CardBody className="space-y-4">
          <Segmented
            label="Preview mode"
            value={cfg.mode}
            onChange={(mode) => setCfg({ ...cfg, mode })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'manual', label: 'Manual' },
              { value: 'automatic', label: 'Automatic' },
            ]}
          />
          <p className="text-xs text-fg-subtle">
            {cfg.mode === 'automatic'
              ? 'A preview is created for every pull request against the service branch.'
              : cfg.mode === 'manual'
                ? 'Previews are created only when you request them (here, or with [nav preview] in the PR title).'
                : 'No previews are created.'}
          </p>
          <Field label="Expire after (days)" hint="Inactive previews are deleted after this many days. 0 keeps them until the PR closes." className="max-w-xs">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={90}
                value={cfg.expireAfterDays}
                disabled={!canWrite || cfg.mode === 'off'}
                onChange={(e) => setCfg({ ...cfg, expireAfterDays: Math.max(0, Number(e.target.value) || 0) })}
              />
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
      </Card>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold">Active previews</h3>
          {canWrite && service.repoUrl && (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setOpen(true)}>
              Create preview from branch
            </Button>
          )}
        </div>
        {previews.isPending ? (
          <SkeletonRows rows={2} />
        ) : previews.isError ? (
          <ErrorState error={previews.error} onRetry={() => previews.refetch()} />
        ) : !previews.data.items.length ? (
          <Empty compact icon={<GitPullRequest className="size-5" />} title="No previews" description="Open a pull request or create one from a branch." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Preview</Th>
                <Th>Status</Th>
                <Th>Branch</Th>
                <Th>URL</Th>
                <Th>Created</Th>
              </tr>
            </THead>
            <TBody>
              {previews.data.items.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <Link className="font-medium text-fg hover:text-accent hover:underline" to={`/w/${ws}/services/${p.id}`}>
                      {p.prNumber ? `PR #${p.prNumber}` : p.name}
                    </Link>
                  </Td>
                  <Td>
                    <StatusPill status={p.status} />
                  </Td>
                  <Td className="font-mono text-xs text-fg-muted">{p.branch ?? '—'}</Td>
                  <Td>
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        {hostnameOf(p.url)}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="text-xs text-fg-muted">
                    <RelativeTime value={p.createdAt} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create preview from branch"
        description="NAV deploys the branch as a separate preview service with its own URL."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="create-preview" loading={create.isPending} disabled={!branch.trim()}>
              Create preview
            </Button>
          </>
        }
      >
        <form id="create-preview" onSubmit={submit} className="space-y-4">
          <Field label="Branch" hint={branches.isError ? 'Could not list branches — type the name instead.' : undefined}>
            {(id) =>
              branchList.length ? (
                <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Select a branch" options={branchList.map((b) => ({ value: b, label: b }))} />
              ) : (
                <Input id={id} mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/new-checkout" />
              )
            }
          </Field>
          <Field label="Pull request number" optional>
            {(id) => <Input id={id} type="number" min={1} value={pr} onChange={(e) => setPr(e.target.value)} placeholder="42" />}
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
