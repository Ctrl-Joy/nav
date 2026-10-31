import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, HardDriveDownload, Pause, Play, Plus, RotateCcw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { DATABASE_PLANS, type Database } from '@nav/shared';
import { buildUrl } from '@/api/client';
import {
  backupDownloadUrl,
  fetchDatabaseLogs,
  useBackups,
  useCreateBackup,
  useDatabaseAction,
  useDatabaseMetrics,
  useDeleteDatabase,
  useRestoreBackup,
  useUpdateDatabase,
} from '@/api/databases';
import type { MetricsRange } from '@/api/keys';
import { LogViewer } from '@/components/logs/LogViewer';
import { useLogTail } from '@/components/logs/useLogTail';
import { latest, MetricCard, RangePicker } from '@/components/MetricCard';
import { PlanPicker } from '@/components/PlanPicker';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Empty,
  ErrorState,
  IconButton,
  Input,
  Select,
  SettingRow,
  SkeletonCard,
  SkeletonRows,
  StatusPill,
  Switch,
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
import { formatBytes, formatNumber } from '@/lib/format';
import { downloadText } from '@/lib/misc';
import { formatDateTime } from '@/lib/time';
import { useDatabaseCtx } from './context';

// Logs ---------------------------------------------------------------------------------------------

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function DatabaseLogsTab() {
  const { database: d } = useDatabaseCtx();
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('');
  const [live, setLive] = useState(true);
  const q = useDebounced(search.trim());

  const tail = useLogTail({
    key: `db:${d.id}:${q}:${level}`,
    fetchPage: ({ before, limit }) => fetchDatabaseLogs(d.id, { before, limit, q: q || undefined, level: level || undefined }),
    streamUrl: (after) => buildUrl(`/databases/${d.id}/logs/stream`, { after, q: q || undefined, level: level || undefined }),
    live,
  });

  const download = () => {
    const text = tail.lines.map((l) => `${l.ts} [${l.level}] ${l.message}`).join('\n');
    downloadText(`${d.slug || d.name}-logs.txt`, text);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-72"
          leading={<Search className="size-3.5" />}
          placeholder="Search logs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search logs"
        />
        <Select
          className="w-36"
          aria-label="Level"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          placeholder="All levels"
          options={['debug', 'info', 'warn', 'error'].map((l) => ({ value: l, label: l }))}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" icon={live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => setLive((v) => !v)}>
            {live ? 'Pause' : 'Resume'}
          </Button>
          <Button size="sm" icon={<Download className="size-3.5" />} disabled={!tail.lines.length} onClick={download}>
            Download
          </Button>
        </div>
      </div>
      {tail.error && <p className="text-xs text-danger">{tail.error}</p>}
      <LogViewer
        label="Database logs"
        lines={tail.lines}
        highlight={q}
        loading={tail.loading}
        state={tail.state}
        hasOlder={tail.hasOlder}
        loadingOlder={tail.loadingOlder}
        onLoadOlder={tail.loadOlder}
        emptyText={q || level ? 'No log lines match these filters.' : 'No database logs yet.'}
      />
    </div>
  );
}

// Metrics ------------------------------------------------------------------------------------------

export function DatabaseMetricsTab() {
  const { database: d } = useDatabaseCtx();
  const [range, setRange] = useState<MetricsRange>('1h');
  const m = useDatabaseMetrics(d.id, range);
  const plan = DATABASE_PLANS.find((p) => p.id === d.plan);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-fg-muted">Refreshes every 30 seconds.</p>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {m.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonCard key={i} className="h-56" />
          ))}
        </div>
      ) : m.isError ? (
        <ErrorState error={m.error} onRetry={() => m.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <MetricCard
            title="CPU"
            value={latest(m.data.cpu) != null ? `${formatNumber(latest(m.data.cpu))} cores` : '—'}
            series={[{ name: 'CPU', data: m.data.cpu ?? [] }]}
            format={(v) => `${+v.toFixed(2)}`}
            limit={plan ? { value: plan.cpu, label: `limit ${plan.cpu}` } : undefined}
          />
          <MetricCard
            title="Memory"
            value={latest(m.data.memoryMB) != null ? `${Math.round(latest(m.data.memoryMB) ?? 0)} MB` : '—'}
            series={[{ name: 'Memory', data: m.data.memoryMB ?? [], color: 'var(--info)' }]}
            format={(v) => `${Math.round(v)} MB`}
            limit={plan ? { value: plan.memoryMB, label: `limit ${plan.memoryMB} MB` } : undefined}
          />
          <MetricCard
            title="Active connections"
            value={latest(m.data.connections) ?? '—'}
            series={[{ name: 'Connections', data: m.data.connections ?? [], color: 'var(--warning)' }]}
            format={(v) => `${Math.round(v)}`}
          />
          <MetricCard
            title="Database size"
            value={formatBytes(latest(m.data.sizeBytes))}
            series={[{ name: 'Size', data: m.data.sizeBytes ?? [], color: 'var(--success)' }]}
            format={(v) => formatBytes(v, 0)}
            limit={{ value: d.diskGB * 1024 ** 3, label: `disk ${d.diskGB} GB` }}
          />
        </div>
      )}
    </div>
  );
}

// Backups ------------------------------------------------------------------------------------------

export function DatabaseBackupsTab() {
  const { database: d } = useDatabaseCtx();
  const { canWrite } = useWorkspace();
  const backups = useBackups(d.id);
  const create = useCreateBackup(d.id);
  const restore = useRestoreBackup(d.id);
  const confirm = useConfirm();
  const toast = useToast();

  const onCreate = async () => {
    try {
      await create.mutateAsync();
      toast.success('Backup started');
    } catch (e) {
      toast.fromError(e, 'Could not start backup');
    }
  };

  const onRestore = async (id: string, createdAt: string) => {
    const ok = await confirm({
      title: 'Restore this backup?',
      body: (
        <p>
          The database will be restored in place to its state at <strong className="text-fg">{formatDateTime(createdAt)}</strong>. All changes made after
          that point will be lost and connections will be interrupted.
        </p>
      ),
      typeToConfirm: d.name,
      confirmText: 'Restore',
      danger: true,
    });
    if (!ok) return;
    try {
      await restore.mutateAsync(id);
      toast.success('Restore started', 'The database status will change to Restoring.');
    } catch (e) {
      toast.fromError(e, 'Could not restore backup');
    }
  };

  return (
    <Card>
      <CardHeader
        title="Backups"
        description="NAV takes automatic daily backups. Create a manual backup before risky migrations."
        actions={
          canWrite && (
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} loading={create.isPending} disabled={d.status !== 'available'} onClick={onCreate}>
              Create backup
            </Button>
          )
        }
      />
      <CardBody>
        {backups.isPending ? (
          <SkeletonRows rows={3} />
        ) : backups.isError ? (
          <ErrorState error={backups.error} onRetry={() => backups.refetch()} />
        ) : !backups.data.items.length ? (
          <Empty compact icon={<HardDriveDownload className="size-4" />} title="No backups yet" description="The first automatic backup runs within 24 hours of creation." />
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
              {backups.data.items.map((b) => (
                <Tr key={b.id}>
                  <Td>
                    <span title={formatDateTime(b.createdAt)}>
                      <RelativeTime value={b.createdAt} />
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={b.kind === 'manual' ? 'accent' : 'neutral'}>{b.kind}</Badge>
                  </Td>
                  <Td>
                    <StatusPill status={b.status} />
                  </Td>
                  <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">{formatBytes(b.sizeBytes)}</Td>
                  <Td className="hidden text-fg-muted md:table-cell">{b.finishedAt ? <RelativeTime value={b.finishedAt} /> : '—'}</Td>
                  <Td>
                    <div className="flex justify-end gap-1.5">
                      {b.status === 'completed' && (
                        <a className={buttonClass('ghost', 'sm')} href={backupDownloadUrl(d.id, b.id)} download>
                          <Download className="size-3.5" /> <span className="hidden sm:inline">Download</span>
                        </a>
                      )}
                      {canWrite && b.status === 'completed' && (
                        <Button size="sm" icon={<RotateCcw className="size-3.5" />} disabled={restore.isPending || d.status !== 'available'} onClick={() => onRestore(b.id, b.createdAt)}>
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
  );
}

// Access control ---------------------------------------------------------------------------------

const CIDR_V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const CIDR_V6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:.]*(\/(12[0-8]|1[01]\d|\d?\d))?$/;

export function isValidCidr(s: string): boolean {
  const v = s.trim();
  return CIDR_V4.test(v) || CIDR_V6.test(v);
}

type AllowRow = Database['ipAllowList'][number];

export function DatabaseAccessTab() {
  const { database: d } = useDatabaseCtx();
  const { ws, canWrite } = useWorkspace();
  const update = useUpdateDatabase({ id: d.id, workspaceId: ws });
  const toast = useToast();
  const [rows, setRows] = useState<AllowRow[]>(d.ipAllowList);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setRows(d.ipAllowList);
  }, [d.ipAllowList, dirty]);

  const set = (next: AllowRow[]) => {
    setRows(next);
    setDirty(true);
  };
  const invalid = rows.findIndex((r) => !isValidCidr(r.cidr));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid >= 0) return;
    try {
      await update.mutateAsync({ ipAllowList: rows.map((r) => ({ cidr: r.cidr.trim(), description: r.description.trim() })) });
      setDirty(false);
      toast.success('Access control updated');
    } catch (err) {
      toast.fromError(err, 'Could not update access control');
    }
  };

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader
          title="Inbound IP rules"
          description="Only these sources may connect via the external URL. Services inside the workspace always connect over the private network."
        />
        <CardBody className="space-y-2">
          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[13px] text-fg-subtle">
              No rules. External connections are blocked.
            </p>
          )}
          {rows.map((r, i) => {
            const bad = !!r.cidr && !isValidCidr(r.cidr);
            return (
              <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-2">
                <div>
                  <Input
                    mono
                    value={r.cidr}
                    placeholder="203.0.113.0/24"
                    aria-label={`Rule ${i + 1} CIDR`}
                    aria-invalid={bad}
                    readOnly={!canWrite}
                    onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, cidr: e.target.value } : x)))}
                  />
                  {bad && <p className="mt-1 text-xs text-danger">Invalid IP or CIDR block</p>}
                </div>
                <Input
                  value={r.description}
                  placeholder="Description (e.g. office)"
                  aria-label={`Rule ${i + 1} description`}
                  readOnly={!canWrite}
                  onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
                {canWrite && <IconButton label="Remove rule" icon={<Trash2 className="size-3.5" />} onClick={() => set(rows.filter((_, j) => j !== i))} />}
              </div>
            );
          })}
          {canWrite && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set([...rows, { cidr: '', description: '' }])}>
                Add rule
              </Button>
              {!rows.some((r) => r.cidr === '0.0.0.0/0') && (
                <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-3.5" />} onClick={() => set([...rows, { cidr: '0.0.0.0/0', description: 'Everywhere' }])}>
                  Allow from anywhere
                </Button>
              )}
            </div>
          )}
          <p className="text-xs text-fg-subtle">Empty list blocks all external connections; add 0.0.0.0/0 to allow everyone.</p>
        </CardBody>
        {canWrite && (
          <CardFooter>
            {dirty && (
              <Button
                onClick={() => {
                  setRows(d.ipAllowList);
                  setDirty(false);
                }}
              >
                Discard
              </Button>
            )}
            <Button variant="primary" type="submit" loading={update.isPending} disabled={!dirty || invalid >= 0}>
              Save rules
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

// Settings ---------------------------------------------------------------------------------------

export function DatabaseSettingsTab() {
  const { database: d } = useDatabaseCtx();
  const { ws, canWrite, isAdmin } = useWorkspace();
  const update = useUpdateDatabase({ id: d.id, workspaceId: ws });
  const action = useDatabaseAction({ id: d.id, workspaceId: ws });
  const del = useDeleteDatabase(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState(d.name);
  const [plan, setPlan] = useState(d.plan);
  const [disk, setDisk] = useState(d.diskGB);
  useEffect(() => setName(d.name), [d.name]);
  useEffect(() => setPlan(d.plan), [d.plan]);
  useEffect(() => setDisk(d.diskGB), [d.diskGB]);

  const saveName = async () => {
    try {
      await update.mutateAsync({ name: name.trim() });
      toast.success('Database renamed');
    } catch (e) {
      toast.fromError(e, 'Could not rename');
    }
  };

  const savePlan = async () => {
    const p = DATABASE_PLANS.find((x) => x.id === plan);
    const ok = await confirm({
      title: `Change plan to ${p?.name ?? plan}?`,
      body: 'PostgreSQL restarts with the new resources. Expect a brief interruption.',
      confirmText: 'Change plan',
    });
    if (!ok) return;
    try {
      await update.mutateAsync({ plan });
      toast.success('Plan change started');
    } catch (e) {
      toast.fromError(e, 'Could not change plan');
    }
  };

  const saveDisk = async () => {
    const ok = await confirm({ title: `Grow disk to ${disk} GB?`, body: 'Disk size can only be increased, not reduced.', confirmText: 'Grow disk' });
    if (!ok) return;
    try {
      await update.mutateAsync({ diskGB: disk });
      toast.success('Disk resized');
    } catch (e) {
      toast.fromError(e, 'Could not resize disk');
    }
  };

  const toggleSuspend = async () => {
    const suspend = d.status !== 'suspended';
    if (suspend) {
      const ok = await confirm({ title: `Suspend ${d.name}?`, body: 'Connections will be refused until you resume. Data is kept.', confirmText: 'Suspend', danger: true });
      if (!ok) return;
    }
    try {
      await action.mutateAsync(suspend ? 'suspend' : 'resume');
      toast.success(suspend ? 'Database suspended' : 'Database resuming');
    } catch (e) {
      toast.fromError(e);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete ${d.name}?`,
      body: 'This permanently deletes the database, its data and all backups. This cannot be undone.',
      typeToConfirm: d.name,
      confirmText: 'Delete database',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(d.id);
      toast.success('Database deleted', d.name);
      navigate(`/w/${ws}/databases`);
    } catch (e) {
      toast.fromError(e, 'Could not delete database');
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="General" />
        <SettingRow title="Name" description="Display name in the dashboard.">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} aria-label="Database name" />
            {canWrite && (
              <Button onClick={saveName} disabled={!name.trim() || name === d.name} loading={update.isPending && name !== d.name}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow title="Disk size" description="Grow storage without downtime. Cannot be decreased.">
          <div className="flex items-center gap-2">
            <Input type="number" min={d.diskGB} max={1024} className="w-28" value={disk} onChange={(e) => setDisk(Number(e.target.value))} disabled={!canWrite} aria-label="Disk size in GB" />
            <span className="text-[13px] text-fg-muted">GB</span>
            {canWrite && (
              <Button onClick={saveDisk} disabled={!Number.isInteger(disk) || disk <= d.diskGB || disk > 1024}>
                Resize
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow title="Suspend" description="Stop the database to save resources. Data and backups are retained.">
          <Switch checked={d.status === 'suspended'} onChange={toggleSuspend} disabled={!canWrite || action.isPending || !['available', 'suspended'].includes(d.status)} label={d.status === 'suspended' ? 'Suspended' : 'Running'} />
        </SettingRow>
      </Card>

      <Card>
        <CardHeader title="Instance type" />
        <CardBody>
          <PlanPicker plans={DATABASE_PLANS} value={plan} onChange={setPlan} disabled={!canWrite} />
        </CardBody>
        {canWrite && (
          <CardFooter>
            <Button variant="primary" disabled={plan === d.plan} onClick={savePlan} loading={update.isPending && plan !== d.plan}>
              Change plan
            </Button>
          </CardFooter>
        )}
      </Card>

      {isAdmin && (
        <Card className="border-danger/40">
          <CardHeader title={<span className="text-danger">Danger zone</span>} />
          <SettingRow title="Delete database" description="Permanently delete this database, its data and every backup.">
            <Button variant="outline-danger" icon={<Trash2 className="size-3.5" />} loading={del.isPending} onClick={onDelete}>
              Delete database
            </Button>
          </SettingRow>
        </Card>
      )}
    </div>
  );
}
