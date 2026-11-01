import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Box, Plus, Trash2 } from 'lucide-react';
import { SANDBOX_LIMITS, type SandboxRuntime } from '@nav/shared';
import { useCreateSandbox, useSandboxMeta, useSandboxSnapshots, useSandboxes, useSnapshotActions } from '@/api/sandboxes';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge, Button, Dialog, Empty, ErrorState, Field, IconButton, Input, PageHeader, Segmented, Select, SkeletonRows, StatusPill, Table, TBody, Td, Textarea, Th, THead, Tr,
  useConfirm, useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatBytes } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';

/** "12m 04s" until `iso`, updated every second; "expired" once it passes. */
export function Countdown({ to, className }: { to: string; className?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((new Date(to).getTime() - now) / 1000));
  const text = s === 0 ? 'expired' : s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return <span className={className ?? (s < 120 ? 'font-mono text-danger' : 'font-mono')}>{text}</span>;
}

const TTL_CHOICES = [
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '14400', label: '4 hours' },
  { value: '86400', label: '24 hours' },
];

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return env;
}

function CreateSandboxDialog({ open, onClose, snapshotId }: { open: boolean; onClose: () => void; snapshotId?: string }) {
  const { ws } = useWorkspace();
  const meta = useSandboxMeta();
  const create = useCreateSandbox(ws);
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [source, setSource] = useState<'runtime' | 'image'>('runtime');
  const [runtime, setRuntime] = useState<SandboxRuntime>('python');
  const [image, setImage] = useState('');
  const [plan, setPlan] = useState('small');
  const [ttl, setTtl] = useState('900');
  const [network, setNetwork] = useState<'none' | 'egress'>('none');
  const [env, setEnv] = useState('');

  const submit = () =>
    create.mutate(
      {
        name: name.trim() || undefined,
        ...(snapshotId ? { snapshotId } : source === 'image' ? { image: image.trim() } : { runtime }),
        plan,
        ttlSeconds: Number(ttl),
        env: parseEnv(env),
        networkAccess: network,
      },
      {
        onSuccess: (sb) => {
          onClose();
          navigate(`/w/${ws}/sandboxes/${sb.id}`);
        },
        onError: (e) => toast.fromError(e, 'Could not create the sandbox'),
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!create.isPending}
      title={snapshotId ? 'New sandbox from snapshot' : 'New sandbox'}
      description="An isolated environment for running code through the API. It is deleted automatically when its time is up."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={source === 'image' && !snapshotId && !image.trim()}>
            Create sandbox
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" optional>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="agent-run" maxLength={64} />}</Field>
        {!snapshotId && (
          <Field label="Environment">
            {() => (
              <div className="space-y-2">
                <Segmented label="Source" value={source} onChange={setSource} options={[{ value: 'runtime', label: 'Runtime' }, { value: 'image', label: 'Image' }]} />
                {source === 'runtime' ? (
                  <Segmented
                    label="Runtime"
                    value={runtime}
                    onChange={setRuntime}
                    options={(['python', 'node', 'bash'] as const).map((r) => ({ value: r, label: `${r} · ${meta.data?.images[r] ?? ''}` }))}
                  />
                ) : (
                  <Input mono value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/org/image:tag" aria-label="Image" />
                )}
              </div>
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan">
            {(id) => (
              <Select
                id={id}
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                options={(meta.data?.plans ?? []).map((p) => ({ value: p.id, label: `${p.name} · ${p.cpu} CPU · ${p.memoryMB} MB` }))}
              />
            )}
          </Field>
          <Field label="Time to live" hint={`Up to ${SANDBOX_LIMITS.maxTtlSeconds / 3600} hours.`}>
            {(id) => <Select id={id} value={ttl} onChange={(e) => setTtl(e.target.value)} options={TTL_CHOICES} />}
          </Field>
        </div>
        <Field label="Network" hint="Without egress the sandbox has no network at all.">
          {() => <Segmented label="Network" value={network} onChange={setNetwork} options={[{ value: 'none', label: 'None' }, { value: 'egress', label: 'Outbound internet' }]} />}
        </Field>
        <Field label="Environment variables" optional hint="KEY=value, one per line. Only these reach the sandbox; values are not stored.">
          {(id) => <Textarea id={id} mono rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="OPENAI_API_KEY=…" />}
        </Field>
      </div>
    </Dialog>
  );
}

function SnapshotsCard() {
  const { ws, canWrite } = useWorkspace();
  const snaps = useSandboxSnapshots(ws);
  const actions = useSnapshotActions(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const [restore, setRestore] = useState<string | null>(null);
  const items = snaps.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-[15px] font-semibold">Snapshots</h2>
      <Table>
        <THead>
          <tr>
            <Th>Snapshot</Th>
            <Th>Status</Th>
            <Th className="hidden md:table-cell">Image</Th>
            <Th className="hidden sm:table-cell">Size</Th>
            <Th className="hidden sm:table-cell">Taken</Th>
            <Th />
          </tr>
        </THead>
        <TBody>
          {items.map((s) => (
            <Tr key={s.id}>
              <Td>
                <div className="font-medium">{s.name ?? s.id}</div>
                <div className="font-mono text-[11px] text-fg-subtle">{s.id}{s.sandboxId ? ` · from ${s.sandboxId}` : ''}</div>
              </Td>
              <Td><StatusPill status={s.status} /></Td>
              <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{s.image}</Td>
              <Td className="hidden text-fg-muted sm:table-cell">{formatBytes(s.sizeBytes)}</Td>
              <Td className="hidden text-fg-muted sm:table-cell"><RelativeTime value={s.createdAt} /></Td>
              <Td className="text-right">
                {canWrite && s.status === 'completed' && (
                  <div className="flex justify-end gap-1">
                    <Button size="xs" onClick={() => setRestore(s.id)}>New sandbox</Button>
                    <IconButton
                      label="Delete snapshot"
                      icon={<Trash2 className="size-3.5" />}
                      onClick={async () => {
                        if (!(await confirm({ title: 'Delete this snapshot?', body: 'Sandboxes already created from it are not affected.', confirmText: 'Delete', danger: true }))) return;
                        actions.remove.mutate(s.id, { onError: (e) => toast.fromError(e, 'Could not delete the snapshot') });
                      }}
                    />
                  </div>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      {restore && <CreateSandboxDialog open onClose={() => setRestore(null)} snapshotId={restore} />}
    </section>
  );
}

export function SandboxesPage() {
  useTitle('Sandboxes');
  const { ws, canWrite } = useWorkspace();
  const [status, setStatus] = useState<'live' | 'all'>('live');
  const sandboxes = useSandboxes(ws, status);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const newButton = canWrite && (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
      New sandbox
    </Button>
  );

  return (
    <div>
      <PageHeader
        icon={<Box className="size-5" />}
        title="Sandboxes"
        description="Isolated, short-lived environments for running code — for example code written by an AI agent — through the API, SDK or CLI."
        actions={newButton}
      />
      <div className="mb-4">
        <Segmented label="Show" value={status} onChange={setStatus} options={[{ value: 'live', label: 'Live' }, { value: 'all', label: 'All' }]} />
      </div>
      {sandboxes.isPending ? (
        <SkeletonRows />
      ) : sandboxes.isError ? (
        <ErrorState error={sandboxes.error} onRetry={() => sandboxes.refetch()} />
      ) : !sandboxes.data.items.length ? (
        <Empty
          icon={<Box />}
          title={status === 'live' ? 'No live sandboxes' : 'No sandboxes yet'}
          description="Create one here, or from code: new NavSandboxes({ host, token }).create({ runtime: 'python' })."
          action={newButton}
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Sandbox</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Image</Th>
              <Th>Expires in</Th>
              <Th className="hidden sm:table-cell">Commands</Th>
              <Th className="hidden lg:table-cell">Created</Th>
            </tr>
          </THead>
          <TBody>
            {sandboxes.data.items.map((s) => (
              <Tr key={s.id} interactive onClick={() => navigate(`/w/${ws}/sandboxes/${s.id}`)}>
                <Td>
                  <Link to={`/w/${ws}/sandboxes/${s.id}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                    {s.name ?? s.id}
                  </Link>
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-fg-subtle">
                    {s.id}
                    {!s.isolated && s.driver && <Badge tone="warning">not isolated</Badge>}
                  </div>
                </Td>
                <Td><StatusPill status={s.status} /></Td>
                <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{s.image}</Td>
                <Td>{s.status === 'running' || s.status === 'starting' ? <Countdown to={s.expiresAt} /> : <span className="text-fg-subtle">—</span>}</Td>
                <Td className="hidden text-fg-muted sm:table-cell">{s.execCount}</Td>
                <Td className="hidden text-fg-muted lg:table-cell"><RelativeTime value={s.createdAt} /></Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <SnapshotsCard />
      {creating && <CreateSandboxDialog open onClose={() => setCreating(false)} />}
    </div>
  );
}
