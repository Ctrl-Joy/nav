// Advanced Postgres tabs: Recovery (PITR), Replicas & HA, Pooling, Extensions, Upgrades, Insights.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowUpCircle, Copy, History, Plus, Puzzle, RefreshCw, Server, Trash2, Wrench } from 'lucide-react';
import { haAvailable, type DbOperation } from '@nav/shared';
import { isApiError } from '@/api/client';
import {
  useCreateReplica,
  useDbOperations,
  useDeleteReplica,
  useExtensions,
  usePooler,
  useRecoverDatabase,
  useRecoveryWindow,
  useRepackTable,
  useReplicas,
  useResetSlowQueries,
  useSetExtension,
  useSetPooler,
  useSlowQueries,
  useTableStats,
  useUpdateDatabase,
  useUpgradeDatabase,
  useUpgradeInfo,
} from '@/api/databases';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Empty,
  ErrorState,
  Field,
  Input,
  Select,
  SettingRow,
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
import { formatDateTime } from '@/lib/time';
import { useDatabaseCtx } from './context';

function Notice({ tone = 'info', children }: { tone?: 'info' | 'warning'; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-2 rounded-[3px] px-3 py-2.5 text-[13px] ${tone === 'warning' ? 'bg-warning-soft text-warning' : 'bg-info-soft text-info'}`}>
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** `<input type="datetime-local">` value (local time, minute precision) for a Date. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function OperationsList({ ops, kind }: { ops: DbOperation[] | undefined; kind: DbOperation['kind'] }) {
  const list = (ops ?? []).filter((o) => o.kind === kind);
  if (!list.length) return null;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Started</Th>
          <Th>Status</Th>
          <Th>Details</Th>
        </tr>
      </THead>
      <TBody>
        {list.slice(0, 5).map((o) => (
          <Tr key={o.id}>
            <Td>
              <span title={formatDateTime(o.createdAt)}>
                <RelativeTime value={o.createdAt} />
              </span>
            </Td>
            <Td>
              <StatusPill status={o.status} />
            </Td>
            <Td className="text-[13px] text-fg-muted">
              {o.error ? (
                <span className="text-danger">{o.error.slice(0, 200)}</span>
              ) : kind === 'upgrade' ? (
                `PostgreSQL ${o.data.from ?? '?'} → ${o.data.to ?? '?'}${o.data.method ? ` (${String(o.data.method).replace('_', ' ')})` : ''}`
              ) : kind === 'repack' ? (
                `${o.data.schema ?? ''}.${o.data.table ?? ''}${o.data.afterBytes != null ? `: ${formatBytes(Number(o.data.beforeBytes))} → ${formatBytes(Number(o.data.afterBytes))} (${o.data.method === 'pg_repack' ? 'pg_repack' : 'VACUUM FULL'})` : ''}`
              ) : (
                JSON.stringify(o.data)
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

// Recovery (PITR) ----------------------------------------------------------------------------------

export function DatabaseRecoveryTab() {
  const { database: d } = useDatabaseCtx();
  const { ws, canWrite } = useWorkspace();
  const w = useRecoveryWindow(d.id);
  const recover = useRecoverDatabase({ id: d.id, workspaceId: ws });
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [when, setWhen] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (!when && w.data?.latest) setWhen(toLocalInput(new Date(Date.now() - 5 * 60_000)));
  }, [w.data?.latest, when]);

  const target = when ? new Date(when) : null;
  const earliest = w.data?.earliest ? new Date(w.data.earliest) : null;
  const outOfWindow = !!target && (!earliest || target < earliest || target > new Date());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || outOfWindow) return;
    const ok = await confirm({
      title: 'Recover to this point in time?',
      body: (
        <p>
          A <strong className="text-fg">new database</strong> is created with the data of <strong className="text-fg">{d.name}</strong> as of{' '}
          <strong className="text-fg">{formatDateTime(target)}</strong>. {d.name} itself is not changed. Point your services at the new database once you have checked it.
        </p>
      ),
      confirmText: 'Start recovery',
    });
    if (!ok) return;
    try {
      const created = await recover.mutateAsync({ targetTime: target.toISOString(), name: name.trim() || undefined });
      toast.success('Recovery started', `${created.name} is being restored.`);
      navigate(`/w/${ws}/databases/${created.id}`);
    } catch (err) {
      toast.fromError(err, 'Could not start recovery');
    }
  };

  return (
    <Card>
      <CardHeader
        title="Point-in-time recovery"
        description="Every change is continuously archived (write-ahead log). Restore the database as it was at any moment in the recovery window into a new database."
      />
      {w.isPending ? (
        <CardBody>
          <SkeletonRows rows={3} />
        </CardBody>
      ) : w.isError ? (
        <CardBody>
          <ErrorState error={w.error} onRetry={() => w.refetch()} />
        </CardBody>
      ) : (
        <>
          <SettingRow title="Recovery window" description={w.data.retentionDays ? `${w.data.retentionDays} days on this instance type.` : 'Not included in this instance type.'}>
            {w.data.earliest ? (
              <div className="space-y-1 text-[13px]">
                <div>
                  <span className="text-fg-muted">From</span> <strong>{formatDateTime(w.data.earliest)}</strong> <span className="text-fg-muted">to</span> <strong>now</strong>
                </div>
                {w.data.lastArchivedAt && (
                  <div className="text-xs text-fg-subtle">
                    Last WAL segment archived <RelativeTime value={w.data.lastArchivedAt} /> (segments are archived at least every minute).
                  </div>
                )}
              </div>
            ) : (
              <Notice>{w.data.reason ?? 'Point-in-time recovery is not available.'}</Notice>
            )}
          </SettingRow>
          {w.data.earliest && canWrite && (
            <form onSubmit={submit}>
              <SettingRow title="Recover" description="Times are in your browser's time zone.">
                <div className="space-y-3">
                  <Field label="Restore to" error={outOfWindow ? 'Pick a time inside the recovery window.' : undefined}>
                    {(fid) => (
                      <Input
                        id={fid}
                        type="datetime-local"
                        step={1}
                        min={earliest ? toLocalInput(earliest) : undefined}
                        max={toLocalInput(new Date())}
                        value={when}
                        onChange={(e) => setWhen(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="New database name" optional>
                    {(fid) => <Input id={fid} value={name} placeholder={`${d.name}-pitr`} onChange={(e) => setName(e.target.value)} maxLength={64} />}
                  </Field>
                </div>
              </SettingRow>
              <CardFooter>
                <Button type="submit" variant="primary" icon={<History className="size-3.5" />} loading={recover.isPending} disabled={!target || outOfWindow || d.status !== 'available'}>
                  Recover to this time
                </Button>
              </CardFooter>
            </form>
          )}
        </>
      )}
    </Card>
  );
}

// Replicas & HA ------------------------------------------------------------------------------------

function lagText(bytes: number | null, seconds: number | null): string {
  if (bytes == null && seconds == null) return '—';
  const parts = [];
  if (seconds != null) parts.push(seconds < 1 ? '< 1 s' : `${formatNumber(seconds)} s`);
  if (bytes != null) parts.push(formatBytes(bytes));
  return parts.join(' · ');
}

export function DatabaseReplicasTab() {
  const { database: d } = useDatabaseCtx();
  const { ws, canWrite } = useWorkspace();
  const replicas = useReplicas(d.id);
  const create = useCreateReplica(d.id);
  const del = useDeleteReplica(d.id);
  const update = useUpdateDatabase({ id: d.id, workspaceId: ws });
  const ops = useDbOperations(d.id);
  const confirm = useConfirm();
  const toast = useToast();
  const [name, setName] = useState('');
  const standby = replicas.data?.items.find((r) => r.role === 'standby');
  const reads = replicas.data?.items.filter((r) => r.role === 'replica') ?? [];
  const paid = haAvailable(d.plan);

  const toggleHa = async (on: boolean) => {
    const ok = await confirm({
      title: on ? 'Enable high availability?' : 'Disable high availability?',
      body: on
        ? 'NAV builds a hot standby kept in sync by streaming replication. If the primary stops responding for about 30 seconds, the standby is promoted automatically and a new standby is built.'
        : 'The standby is removed. If the primary fails, the database stays down until it is restarted or restored.',
      confirmText: on ? 'Enable' : 'Disable',
      danger: !on,
    });
    if (!ok) return;
    try {
      await update.mutateAsync({ highAvailability: on });
      toast.success(on ? 'Building the standby' : 'High availability disabled');
      replicas.refetch();
    } catch (err) {
      toast.fromError(err, 'Could not change high availability');
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync(name.trim() || undefined);
      setName('');
      toast.success('Read replica requested', 'It is cloned from the primary and starts streaming in a minute or two.');
    } catch (err) {
      toast.fromError(err, 'Could not create read replica');
    }
  };

  const remove = async (id: string, rname: string) => {
    const ok = await confirm({ title: `Delete replica ${rname}?`, body: 'Applications using its connection string will lose their connection.', confirmText: 'Delete replica', danger: true });
    if (!ok) return;
    try {
      await del.mutateAsync(id);
      toast.success('Replica deleted');
    } catch (err) {
      toast.fromError(err, 'Could not delete replica');
    }
  };

  const failovers = (ops.data?.items ?? []).filter((o) => o.kind === 'failover');

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="High availability" description="A hot standby with automatic failover." />
        <SettingRow
          title="Standby"
          description="Connection strings keep working after a failover: the promoted standby takes over the primary's port. If that port cannot be reused, the external port changes and is shown on the Info tab."
        >
          <div className="space-y-3">
            <Switch
              checked={d.highAvailability}
              onChange={toggleHa}
              disabled={!canWrite || !paid || update.isPending || d.status !== 'available'}
              label={d.highAvailability ? 'Enabled' : 'Disabled'}
              description={paid ? undefined : 'Available on paid instance types.'}
            />
            {d.highAvailability && (
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                {standby ? (
                  <>
                    <StatusPill status={standby.status} />
                    {standby.state && <Badge tone={standby.state === 'streaming' ? 'success' : 'warning'}>{standby.state}</Badge>}
                    <span className="text-fg-muted">lag {lagText(standby.lagBytes, standby.lagSeconds)}</span>
                    {standby.error && <span className="text-danger">{standby.error.slice(0, 160)}</span>}
                  </>
                ) : (
                  <span className="text-fg-muted">Standby is being created…</span>
                )}
              </div>
            )}
          </div>
        </SettingRow>
        {failovers.length > 0 && (
          <SettingRow title="Failovers" description="Automatic promotions of the standby.">
            <ul className="space-y-1 text-[13px]">
              {failovers.slice(0, 5).map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2">
                  <StatusPill status={o.status} />
                  <span title={formatDateTime(o.createdAt)}>
                    <RelativeTime value={o.createdAt} />
                  </span>
                  {o.data.portChanged ? <Badge tone="warning">port {String(o.data.previousPort)} → {String(o.data.port)}</Badge> : null}
                  {o.data.downtimeSeconds != null && <span className="text-fg-muted">~{String(o.data.downtimeSeconds)} s unavailable</span>}
                  {o.error && <span className="text-danger">{o.error}</span>}
                </li>
              ))}
            </ul>
          </SettingRow>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Read replicas"
          description="Read-only copies kept up to date by streaming replication. Send reporting and analytics queries here to offload the primary."
        />
        <CardBody>
          {replicas.isPending ? (
            <SkeletonRows rows={2} />
          ) : replicas.isError ? (
            <ErrorState error={replicas.error} onRetry={() => replicas.refetch()} />
          ) : !reads.length ? (
            <Empty compact icon={<Copy className="size-4" />} title="No read replicas" description={paid ? 'Add one below.' : 'Read replicas are available on paid instance types.'} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th className="hidden md:table-cell">Replication lag</Th>
                  <Th className="hidden lg:table-cell">External URL</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {reads.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium">{r.name}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill status={r.status} />
                        {r.state && r.state !== 'streaming' && <Badge tone="warning">{r.state}</Badge>}
                      </div>
                      {r.error && <p className="mt-1 text-xs text-danger">{r.error.slice(0, 160)}</p>}
                    </Td>
                    <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{lagText(r.lagBytes, r.lagSeconds)}</Td>
                    <Td className="hidden font-mono text-xs text-fg-muted lg:table-cell">{r.externalUrl ?? '—'}</Td>
                    <Td>
                      <div className="flex justify-end">
                        {canWrite && (
                          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={r.status === 'deleting' || del.isPending} onClick={() => remove(r.id, r.name)}>
                            <span className="hidden sm:inline">Delete</span>
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
          {reads.length > 0 && <p className="mt-3 text-xs text-fg-subtle">Full read-only connection strings (with password) are on the Info tab.</p>}
        </CardBody>
        {canWrite && paid && (
          <form onSubmit={add}>
            <CardFooter>
              <Input className="w-full sm:w-64" placeholder="Replica name (optional)" aria-label="Replica name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
              <Button type="submit" variant="primary" icon={<Plus className="size-3.5" />} loading={create.isPending} disabled={d.status !== 'available' || reads.length >= 5}>
                Add read replica
              </Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  );
}

// Pooling ------------------------------------------------------------------------------------------

export function DatabasePoolingTab() {
  const { database: d } = useDatabaseCtx();
  const { ws, canWrite } = useWorkspace();
  const pooler = usePooler(d.id);
  const set = useSetPooler({ id: d.id, workspaceId: ws });
  const toast = useToast();

  const toggle = async (on: boolean) => {
    try {
      await set.mutateAsync(on);
      toast.success(on ? 'Connection pooling enabled' : 'Connection pooling disabled');
    } catch (err) {
      toast.fromError(err, 'Could not change connection pooling');
    }
  };

  return (
    <Card>
      <CardHeader title="Connection pooling" description="PgBouncer in transaction mode lets thousands of short-lived client connections share a small pool of server connections." />
      {pooler.isPending ? (
        <CardBody>
          <SkeletonRows rows={2} />
        </CardBody>
      ) : pooler.isError ? (
        <CardBody>
          <ErrorState error={pooler.error} onRetry={() => pooler.refetch()} />
        </CardBody>
      ) : (
        <>
          {!pooler.data.available && (
            <CardBody className="border-b border-border">
              <Notice tone="warning">{pooler.data.reason}</Notice>
            </CardBody>
          )}
          <SettingRow title="PgBouncer" description="Pool mode: transaction.">
            <Switch
              checked={pooler.data.enabled}
              onChange={toggle}
              disabled={!canWrite || set.isPending || d.status !== 'available' || (!pooler.data.available && !pooler.data.enabled)}
              label={pooler.data.enabled ? 'Enabled' : 'Disabled'}
            />
          </SettingRow>
          {pooler.data.enabled && (
            <SettingRow title="Pooled connection" description="The full URL with password is on the Info tab.">
              <div className="space-y-1">
                <div className="font-mono text-xs break-all">{pooler.data.pooledExternalUrl ?? 'Starting…'}</div>
                {pooler.data.port && <div className="text-xs text-fg-subtle">Port {pooler.data.port}</div>}
              </div>
            </SettingRow>
          )}
          <SettingRow title="Transaction mode caveats" description="Each transaction may run on a different server connection.">
            <ul className="list-disc space-y-1 pl-4 text-[13px] text-fg-muted">
              <li>Session state does not persist between transactions: avoid session-level SET, advisory locks, LISTEN/NOTIFY and WITH HOLD cursors.</li>
              <li>Use the direct connection for migrations and long-lived sessions.</li>
            </ul>
          </SettingRow>
        </>
      )}
    </Card>
  );
}

// Extensions ---------------------------------------------------------------------------------------

export function DatabaseExtensionsTab() {
  const { database: d } = useDatabaseCtx();
  const { canWrite } = useWorkspace();
  const ext = useExtensions(d.id);
  const set = useSetExtension(d.id);
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, install: boolean) => {
    if (!install) {
      const ok = await confirm({ title: `Remove ${name}?`, body: 'DROP EXTENSION fails if tables, columns or functions still depend on it.', confirmText: 'Remove', danger: true });
      if (!ok) return;
    }
    setBusy(name);
    try {
      await set.mutateAsync({ name, install });
      toast.success(install ? `${name} installed` : `${name} removed`);
    } catch (err) {
      if (!install && isApiError(err) && err.status === 409) {
        const force = await confirm({
          title: `Objects depend on ${name}`,
          body: <p className="break-words">{err.message} Remove the extension and every object that depends on it?</p>,
          confirmText: 'Remove with dependents',
          danger: true,
          typeToConfirm: name,
        });
        if (force) {
          try {
            await set.mutateAsync({ name, install: false, cascade: true });
            toast.success(`${name} removed`);
          } catch (e2) {
            toast.fromError(e2, 'Could not remove extension');
          }
        }
      } else toast.fromError(err, install ? 'Could not install extension' : 'Could not remove extension');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title="Extensions" description="Supported extensions available on this server. Installing runs CREATE EXTENSION in the database." />
      <CardBody>
        {d.status !== 'available' ? (
          <Empty compact icon={<Puzzle className="size-4" />} title={`Database is ${d.status}`} />
        ) : ext.isPending ? (
          <SkeletonRows rows={6} />
        ) : ext.isError ? (
          <ErrorState error={ext.error} onRetry={() => ext.refetch()} />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Extension</Th>
                <Th className="hidden md:table-cell">Description</Th>
                <Th>Version</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </THead>
            <TBody>
              {ext.data.items.map((x) => (
                <Tr key={x.name}>
                  <Td className="font-mono text-xs">
                    {x.name}
                    {!x.ready && (
                      <div className="mt-1 font-sans text-xs text-warning">Restart the database to load it.</div>
                    )}
                  </Td>
                  <Td className="hidden text-[13px] text-fg-muted md:table-cell">{x.comment}</Td>
                  <Td className="font-mono text-xs">{x.installedVersion ? <Badge tone="success">{x.installedVersion}</Badge> : <span className="text-fg-subtle">{x.defaultVersion}</span>}</Td>
                  <Td>
                    <div className="flex justify-end">
                      {canWrite &&
                        (x.installedVersion ? (
                          <Button size="sm" variant="ghost" loading={busy === x.name} disabled={!!busy} onClick={() => run(x.name, false)}>
                            Remove
                          </Button>
                        ) : (
                          <Button size="sm" loading={busy === x.name} disabled={!!busy} onClick={() => run(x.name, true)}>
                            Install
                          </Button>
                        ))}
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

// Upgrades -----------------------------------------------------------------------------------------

export function DatabaseUpgradesTab() {
  const { database: d } = useDatabaseCtx();
  const { ws, isAdmin } = useWorkspace();
  const info = useUpgradeInfo(d.id);
  const upgrade = useUpgradeDatabase({ id: d.id, workspaceId: ws });
  const ops = useDbOperations(d.id);
  const confirm = useConfirm();
  const toast = useToast();
  const [version, setVersion] = useState('');
  const targets = useMemo(() => info.data?.targets ?? [], [info.data]);
  useEffect(() => {
    if (!version && targets.length) setVersion(String(targets[targets.length - 1].version));
  }, [targets, version]);
  const target = targets.find((t) => String(t.version) === version);

  const run = async () => {
    if (!target) return;
    const ok = await confirm({
      title: `Upgrade to PostgreSQL ${target.version}?`,
      body: (
        <div className="space-y-2">
          <p>
            {target.method === 'pg_upgrade'
              ? 'The database stops while pg_upgrade migrates the data files (usually a few minutes).'
              : 'Writes are paused while the data is dumped and restored into a new cluster; the time depends on the database size.'}{' '}
            The current cluster is kept until the new one is running, and restored automatically if anything fails.
          </p>
          <p>Read replicas and the standby are rebuilt afterwards. The point-in-time recovery window restarts at the upgrade.</p>
        </div>
      ),
      typeToConfirm: d.name,
      confirmText: 'Upgrade',
      danger: true,
    });
    if (!ok) return;
    try {
      await upgrade.mutateAsync(target.version);
      toast.success('Upgrade started');
      ops.refetch();
    } catch (err) {
      toast.fromError(err, 'Could not start the upgrade');
    }
  };

  return (
    <Card>
      <CardHeader title="Major version upgrade" description="Move to a newer PostgreSQL major version in place. Connection strings do not change." />
      {info.isPending ? (
        <CardBody>
          <SkeletonRows rows={2} />
        </CardBody>
      ) : info.isError ? (
        <CardBody>
          <ErrorState error={info.error} onRetry={() => info.refetch()} />
        </CardBody>
      ) : (
        <>
          <SettingRow title="Current version" description="Test your application against the target version first (e.g. on a point-in-time recovery copy).">
            <span className="text-[14px] font-semibold">PostgreSQL {info.data.currentVersion}</span>
          </SettingRow>
          <SettingRow title="Upgrade to">
            {targets.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  className="w-56"
                  aria-label="Target version"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  options={targets.map((t) => ({ value: String(t.version), label: `PostgreSQL ${t.version} (${t.method === 'pg_upgrade' ? 'pg_upgrade' : 'dump & restore'})` }))}
                />
                {isAdmin && (
                  <Button variant="primary" icon={<ArrowUpCircle className="size-3.5" />} loading={upgrade.isPending} disabled={!target || d.status !== 'available'} onClick={run}>
                    Upgrade
                  </Button>
                )}
              </div>
            ) : (
              <Notice>{info.data.reason ?? 'No upgrade available.'}</Notice>
            )}
          </SettingRow>
          {(ops.data?.items ?? []).some((o) => o.kind === 'upgrade') && (
            <CardBody className="border-t border-border">
              <OperationsList ops={ops.data?.items} kind="upgrade" />
            </CardBody>
          )}
        </>
      )}
    </Card>
  );
}

// Insights -----------------------------------------------------------------------------------------

export function DatabaseInsightsTab() {
  const { database: d } = useDatabaseCtx();
  const { canWrite, isAdmin } = useWorkspace();
  const available = d.status === 'available';
  const slow = useSlowQueries(d.id, canWrite && available);
  const reset = useResetSlowQueries(d.id);
  const tables = useTableStats(d.id);
  const repack = useRepackTable(d.id);
  const ops = useDbOperations(d.id);
  const confirm = useConfirm();
  const toast = useToast();

  const onRepack = async (schema: string, table: string) => {
    const ok = await confirm({
      title: `Repack ${schema}.${table}?`,
      body: (
        <div className="space-y-2">
          <p>Rewrites the table and its indexes to give unused space back to the operating system.</p>
          <p className="text-warning">
            Without pg_repack this runs VACUUM FULL, which locks the table against reads and writes until it finishes, and needs free disk space about the size of the table.
          </p>
        </div>
      ),
      confirmText: 'Repack table',
      danger: true,
    });
    if (!ok) return;
    try {
      await repack.mutateAsync({ schema, table });
      toast.success('Repack started');
    } catch (err) {
      toast.fromError(err, 'Could not start repack');
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Slow queries"
          description="Top 20 statements by total execution time (pg_stat_statements)."
          actions={
            canWrite && (
              <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={reset.isPending} disabled={!available} onClick={() => reset.mutateAsync().then(() => toast.success('Statistics reset'), (e) => toast.fromError(e))}>
                Reset statistics
              </Button>
            )
          }
        />
        <CardBody>
          {!canWrite ? (
            <p className="text-[13px] text-fg-muted">Query text is only visible to developers and admins.</p>
          ) : !available ? (
            <Empty compact icon={<Server className="size-4" />} title={`Database is ${d.status}`} />
          ) : slow.isPending ? (
            <SkeletonRows rows={4} />
          ) : slow.isError ? (
            isApiError(slow.error) && slow.error.status === 409 ? <Notice>{slow.error.message}</Notice> : <ErrorState error={slow.error} onRetry={() => slow.refetch()} />
          ) : !slow.data.items.length ? (
            <Empty compact title="No statements recorded yet" description="Statistics appear as the application runs queries." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Query</Th>
                  <Th className="text-right">Calls</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="hidden text-right sm:table-cell">Mean</Th>
                  <Th className="hidden text-right md:table-cell">Rows</Th>
                  <Th className="hidden text-right lg:table-cell">Cache hit</Th>
                </tr>
              </THead>
              <TBody>
                {slow.data.items.map((s) => (
                  <Tr key={s.queryId}>
                    <Td className="max-w-[420px]">
                      <code className="line-clamp-3 font-mono text-xs break-all" title={s.query}>
                        {s.query}
                      </code>
                    </Td>
                    <Td className="text-right font-mono text-xs">{s.calls.toLocaleString()}</Td>
                    <Td className="text-right font-mono text-xs">{formatNumber(s.totalMs)} ms</Td>
                    <Td className="hidden text-right font-mono text-xs sm:table-cell">{formatNumber(s.meanMs, 2)} ms</Td>
                    <Td className="hidden text-right font-mono text-xs md:table-cell">{s.rows.toLocaleString()}</Td>
                    <Td className="hidden text-right font-mono text-xs lg:table-cell">{s.cacheHitRatio == null ? '—' : `${(s.cacheHitRatio * 100).toFixed(1)}%`}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Tables" description="Largest tables with dead rows and an estimate of reclaimable space (bloat)." />
        <CardBody>
          {!available ? (
            <Empty compact icon={<Server className="size-4" />} title={`Database is ${d.status}`} />
          ) : tables.isPending ? (
            <SkeletonRows rows={4} />
          ) : tables.isError ? (
            <ErrorState error={tables.error} onRetry={() => tables.refetch()} />
          ) : !tables.data.items.length ? (
            <Empty compact title="No tables yet" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Table</Th>
                  <Th className="text-right">Total size</Th>
                  <Th className="hidden text-right md:table-cell">Indexes</Th>
                  <Th className="hidden text-right sm:table-cell">Dead rows</Th>
                  <Th className="text-right">Est. bloat</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {tables.data.items.map((t) => {
                  const heavy = t.bloatBytes != null && t.bloatBytes > 0.3 * t.tableBytes && t.bloatBytes > 1048576;
                  return (
                    <Tr key={`${t.schema}.${t.table}`}>
                      <Td className="font-mono text-xs">
                        {t.schema === 'public' ? t.table : `${t.schema}.${t.table}`}
                        <div className="font-sans text-xs text-fg-subtle">
                          {t.lastAutovacuum || t.lastVacuum ? (
                            <>
                              vacuumed <RelativeTime value={(t.lastAutovacuum ?? t.lastVacuum)!} />
                            </>
                          ) : (
                            'never vacuumed'
                          )}
                        </div>
                      </Td>
                      <Td className="text-right font-mono text-xs">{formatBytes(t.totalBytes)}</Td>
                      <Td className="hidden text-right font-mono text-xs md:table-cell">{formatBytes(t.indexBytes)}</Td>
                      <Td className="hidden text-right font-mono text-xs sm:table-cell">{t.deadTuples.toLocaleString()}</Td>
                      <Td className="text-right font-mono text-xs">{t.bloatBytes == null ? '—' : <span className={heavy ? 'text-warning' : ''}>{formatBytes(t.bloatBytes)}</span>}</Td>
                      <Td>
                        <div className="flex justify-end">
                          {isAdmin && (
                            <Button size="sm" variant="ghost" icon={<Wrench className="size-3.5" />} disabled={repack.isPending} onClick={() => onRepack(t.schema, t.table)}>
                              <span className="hidden sm:inline">Repack</span>
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          )}
          {(ops.data?.items ?? []).some((o) => o.kind === 'repack') && (
            <div className="mt-4">
              <h4 className="mb-2 text-[13px] font-semibold">Recent repacks</h4>
              <OperationsList ops={ops.data?.items} kind="repack" />
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
