import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Download, Gauge, Info } from 'lucide-react';
import type { UsagePlanLine, UsageReport } from '@nav/shared';
import { errorMessage } from '@/api/client';
import { fetchUsageCsv, useUsage } from '@/api/usage';
import { MetricCard } from '@/components/MetricCard';
import { Badge, Button, Card, CardHeader, Empty, ErrorState, IconButton, PageHeader, Select, SkeletonCard, SkeletonRows, Table, TBody, Td, Th, THead, Tr, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatBytes, formatNumber } from '@/lib/format';
import { downloadText } from '@/lib/misc';
import { useTitle } from '@/lib/useTitle';

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** YYYY-MM shifted by n months (UTC). */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (n: number) => `${formatNumber(n)} h`;

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-[12.5px] text-fg-muted">{label}</div>
      <div className="mt-1 font-mono text-[18px] font-semibold text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-[11.5px] text-fg-subtle">{hint}</div>}
    </div>
  );
}

function Plans({ lines }: { lines: UsagePlanLine[] }) {
  if (!lines.length) return <span className="text-fg-subtle">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {lines.map((l) => (
        <Badge key={l.plan}>
          {l.planName}
          {lines.length > 1 && <span className="font-mono text-fg-muted"> {formatNumber(l.hours)}h</span>}
        </Badge>
      ))}
    </div>
  );
}

function PlanTable({ title, lines }: { title: string; lines: UsagePlanLine[] }) {
  return (
    <div>
      <h3 className="mb-1.5 px-4 text-[12.5px] font-medium text-fg-muted">{title}</h3>
      {!lines.length ? (
        <p className="px-4 pb-3 text-[13px] text-fg-subtle">None this month.</p>
      ) : (
        <dl className="px-4 pb-3 text-[13px]">
          {lines.map((l) => (
            <div key={l.plan} className="flex items-baseline justify-between gap-3 py-1">
              <dt>{l.planName}</dt>
              <dd className="font-mono text-xs text-fg-muted">
                {hours(l.hours)} · <span className="text-fg">{usd(l.estimatedCost)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ResourceName({ to, name, deleted }: { to: string; name: string; deleted: boolean }) {
  return deleted ? (
    <span className="text-fg-muted">
      {name} <Badge>deleted</Badge>
    </span>
  ) : (
    <Link to={to} className="font-medium hover:underline">
      {name}
    </Link>
  );
}

function Report({ r, ws }: { r: UsageReport; ws: string }) {
  const t = r.totals;
  const bandwidth = useMemo(() => [{ name: 'Bandwidth', data: r.daily.map((d) => [d.day, d.bandwidthBytes] as [string, number]), color: 'var(--info)' }], [r.daily]);
  const instance = useMemo(() => [{ name: 'Instance hours', data: r.daily.map((d) => [d.day, d.instanceHours] as [string, number]) }], [r.daily]);
  const data = [
    ...r.databases.map((d) => ({ ...d, kind: 'Postgres', to: `/w/${ws}/databases/${d.id}`, storage: d.storageGBMonths as number | null })),
    ...r.keyValues.map((k) => ({ ...k, kind: 'Key Value', to: `/w/${ws}/key-value/${k.id}`, storage: null })),
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Estimated cost" value={usd(t.estimatedCost)} hint={r.partial ? 'month to date · estimate' : 'estimate'} />
        <Stat label="Instance hours" value={formatNumber(t.instanceHours)} />
        <Stat label="Bandwidth out" value={formatBytes(t.bandwidthBytes)} />
        <Stat label="Build minutes" value={formatNumber(t.buildMinutes)} />
        <Stat label="Disk" value={`${formatNumber(t.diskGBMonths)} GB-mo`} />
        <Stat label="Postgres hours" value={formatNumber(t.databaseHours)} />
        <Stat label="Key Value hours" value={formatNumber(t.keyValueHours)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <MetricCard title="Bandwidth out per day" value={formatBytes(t.bandwidthBytes)} series={bandwidth} format={(v) => formatBytes(v, 0)} />
        <MetricCard title="Instance hours per day" value={formatNumber(t.instanceHours)} series={instance} format={(v) => formatNumber(v)} />
      </div>

      <Card>
        <CardHeader title="Hours by plan" description="Monthly plan prices prorated over 730 hours." />
        <div className="grid gap-2 md:grid-cols-3">
          <PlanTable title="Service instances" lines={r.instanceHoursByPlan} />
          <PlanTable title="Postgres" lines={r.databaseHoursByPlan} />
          <PlanTable title="Key Value" lines={r.keyValueHoursByPlan} />
        </div>
      </Card>

      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Services</h2>
        {!r.services.length ? (
          <Empty compact title="No service usage" description="No service ran, built or served traffic in this month." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Service</Th>
                <Th>Plan</Th>
                <Th className="text-right">Instance hours</Th>
                <Th className="text-right">Bandwidth</Th>
                <Th className="text-right">Build min</Th>
                <Th className="text-right">Disk GB-mo</Th>
                <Th className="text-right">Est. cost</Th>
              </tr>
            </THead>
            <TBody>
              {r.services.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <ResourceName to={`/w/${ws}/services/${s.id}`} name={s.name} deleted={s.deleted} />
                    {s.type && <div className="text-[11.5px] text-fg-subtle">{s.type}</div>}
                  </Td>
                  <Td><Plans lines={s.plans} /></Td>
                  <Td className="text-right font-mono text-xs">{formatNumber(s.instanceHours)}</Td>
                  <Td className="text-right font-mono text-xs">{formatBytes(s.bandwidthBytes)}</Td>
                  <Td className="text-right font-mono text-xs">{formatNumber(s.buildMinutes)}</Td>
                  <Td className="text-right font-mono text-xs">{s.diskGBMonths ? formatNumber(s.diskGBMonths) : '—'}</Td>
                  <Td className="text-right font-mono text-xs">{usd(s.estimatedCost)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Postgres and Key Value</h2>
        {!data.length ? (
          <Empty compact title="No datastore usage" description="No Postgres database or Key Value instance ran in this month." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>Plan</Th>
                <Th className="text-right">Hours</Th>
                <Th className="text-right">Storage GB-mo</Th>
                <Th className="text-right">Est. cost</Th>
              </tr>
            </THead>
            <TBody>
              {data.map((d) => (
                <Tr key={d.id}>
                  <Td><ResourceName to={d.to} name={d.name} deleted={d.deleted} /></Td>
                  <Td className="text-fg-muted">{d.kind}</Td>
                  <Td><Plans lines={d.plans} /></Td>
                  <Td className="text-right font-mono text-xs">{formatNumber(d.hours)}</Td>
                  <Td className="text-right font-mono text-xs">{d.storage == null ? '—' : formatNumber(d.storage)}</Td>
                  <Td className="text-right font-mono text-xs">{usd(d.estimatedCost)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}

export function UsagePage() {
  useTitle('Usage');
  const { ws, canWrite } = useWorkspace();
  const toast = useToast();
  const [month, setMonth] = useState(thisMonth);
  const [downloading, setDownloading] = useState(false);
  const usage = useUsage(ws, month, canWrite);
  const latest = thisMonth();
  const months = useMemo(() => Array.from({ length: 13 }, (_, i) => shiftMonth(latest, -i)).map((m) => ({ value: m, label: monthLabel(m) })), [latest]);

  if (!canWrite) {
    return <Empty title="Developers and admins only" description="Ask a workspace admin for developer access to view usage." />;
  }

  const download = async () => {
    setDownloading(true);
    try {
      downloadText(`nav-usage-${ws}-${month}.csv`, await fetchUsageCsv(ws, month), 'text/csv');
    } catch (e) {
      toast.error('Could not download usage', errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<Gauge className="size-4" />}
        title="Usage"
        description="Compute, bandwidth, builds and storage used by this workspace, by month (UTC)."
        actions={
          <Button icon={<Download className="size-3.5" />} loading={downloading} disabled={!usage.data} onClick={download}>
            CSV
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <IconButton icon={<ChevronLeft className="size-3.5" />} label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))} />
        <Select className="w-48" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} options={months.some((o) => o.value === month) ? months : [{ value: month, label: monthLabel(month) }, ...months]} />
        <IconButton icon={<ChevronRight className="size-3.5" />} label="Next month" disabled={month >= latest} onClick={() => setMonth((m) => shiftMonth(m, 1))} />
        {usage.isFetching && !usage.isPending && <span className="text-xs text-fg-subtle">updating…</span>}
      </div>
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-panel px-3 py-2.5 text-[13px] text-fg-muted">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Costs are an <strong className="font-medium text-fg">estimate — NAV does not bill</strong>. They prorate each plan's monthly price over the hours it ran, plus
          persistent disks at $0.25 per GB-month.
        </span>
      </div>
      {usage.isPending ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} className="h-20" />)}
          </div>
          <SkeletonRows rows={6} />
        </div>
      ) : usage.isError ? (
        <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
      ) : (
        <Report r={usage.data} ws={ws} />
      )}
    </div>
  );
}
