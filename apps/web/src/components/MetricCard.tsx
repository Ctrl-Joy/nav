import type { ReactNode } from 'react';
import type { MetricsRange } from '@/api/keys';
import { Chart, Segmented, type ChartSeries } from '@/components/ui';

export const RANGE_OPTIONS: { value: MetricsRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
];

export function RangePicker({ value, onChange }: { value: MetricsRange; onChange: (v: MetricsRange) => void }) {
  return <Segmented label="Time range" value={value} onChange={onChange} options={RANGE_OPTIONS} />;
}

/** Latest value of a series (or null). */
export function latest(series: [string, number][] | undefined): number | null {
  return series && series.length ? series[series.length - 1][1] : null;
}

export function MetricCard({
  title,
  value,
  series,
  format,
  limit,
  area,
  footer,
}: {
  title: string;
  value?: ReactNode;
  series: ChartSeries[];
  format?: (v: number) => string;
  limit?: { value: number; label: string };
  area?: boolean;
  footer?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg-muted">{title}</h3>
        {value !== undefined && <span className="font-mono text-[15px] font-semibold text-fg">{value}</span>}
      </div>
      <Chart ariaLabel={`${title} chart`} series={series} format={format} limit={limit} area={area} height={150} />
      {footer && <div className="mt-2 text-xs text-fg-subtle">{footer}</div>}
    </section>
  );
}
