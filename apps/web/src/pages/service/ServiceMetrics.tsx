import { useState } from 'react';
import type { MetricsRange } from '@/api/keys';
import { useServiceMetrics } from '@/api/services';
import { latest, MetricCard, RangePicker } from '@/components/MetricCard';
import { ErrorState, SkeletonCard } from '@/components/ui';
import { formatBytes, formatNumber } from '@/lib/format';
import { useServiceCtx } from './context';

const fmtCpu = (v: number) => `${+v.toFixed(2)}`;
const fmtMem = (v: number) => (v >= 1024 ? `${+(v / 1024).toFixed(1)}G` : `${Math.round(v)}M`);
const fmtMs = (v: number) => `${Math.round(v)}ms`;
const fmtInt = (v: number) => formatNumber(v, 1);
const fmtBytes = (v: number) => formatBytes(v, 0);
const show = <T,>(v: number | null, f: (n: number) => T) => (v == null ? '—' : f(v));

export function ServiceMetricsTab() {
  const { service } = useServiceCtx();
  const [range, setRange] = useState<MetricsRange>('1h');
  const q = useServiceMetrics(service.id, range);
  const m = q.data;
  const http = service.type === 'web' || service.type === 'static';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-fg-muted">Refreshes every 30 seconds{q.isFetching ? ' · updating…' : ''}.</p>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {q.isError && !m && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.isPending && (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonCard key={i} className="h-56" />
          ))}
        </div>
      )}
      {m && (
        <div className="grid gap-4 lg:grid-cols-2">
          <MetricCard
            title="CPU (cores)"
            value={show(latest(m.cpu), fmtCpu)}
            series={[{ name: 'CPU', data: m.cpu }]}
            format={fmtCpu}
            limit={m.cpuLimit ? { value: m.cpuLimit, label: `limit ${m.cpuLimit}` } : undefined}
          />
          <MetricCard
            title="Memory"
            value={show(latest(m.memoryMB), fmtMem)}
            series={[{ name: 'Memory', data: m.memoryMB, color: 'var(--info)' }]}
            format={fmtMem}
            limit={m.memoryLimitMB ? { value: m.memoryLimitMB, label: `limit ${fmtMem(m.memoryLimitMB)}` } : undefined}
          />
          <MetricCard
            title="Instances"
            value={show(latest(m.instances), fmtInt)}
            series={[{ name: 'Instances', data: m.instances, color: 'var(--success)' }]}
            format={fmtInt}
            area={false}
          />
          {http && (
            <>
              <MetricCard title="HTTP requests / min" value={show(latest(m.requests), fmtInt)} series={[{ name: 'Requests', data: m.requests }]} format={fmtInt} />
              <MetricCard
                title="5xx responses / min"
                value={show(latest(m.errors5xx), fmtInt)}
                series={[{ name: '5xx', data: m.errors5xx, color: 'var(--danger)' }]}
                format={fmtInt}
              />
              <MetricCard
                title="Average latency"
                value={show(latest(m.latencyAvgMs), fmtMs)}
                series={[{ name: 'Latency', data: m.latencyAvgMs, color: 'var(--warning)' }]}
                format={fmtMs}
              />
              <MetricCard
                title="Bandwidth"
                value={show(latest(m.bandwidthBytes), fmtBytes)}
                series={[{ name: 'Bandwidth', data: m.bandwidthBytes, color: 'var(--info)' }]}
                format={fmtBytes}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
