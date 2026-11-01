// Usage reports: instance / database / Key Value hours by plan, bandwidth, build minutes and disk GB-months for one
// UTC month, read from the trigger-maintained ledger (usage_periods, usage_bandwidth_daily, usage_resources; see
// migration 018). Every span is clipped to the month (and to now for the current month). Costs are estimates
// from the plans' monthly prices prorated over HOURS_PER_MONTH: NAV does not bill.
import {
  DATABASE_PLANS, DISK_PRICE_GB_MONTH, HOURS_PER_MONTH, KEY_VALUE_PLANS, SERVICE_PLANS,
  type Plan, type UsagePlanLine, type UsageReport,
} from '@nav/shared';
import { q } from '../db/pool.ts';

export const USAGE_DISCLAIMER = 'estimate — NAV does not bill';

/** [start, end) of a YYYY-MM month in UTC; null if malformed. */
export function monthRange(month: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
}

export const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const priceOf = (plans: Plan[], id: string | null) => plans.find((p) => p.id === id)?.priceMonthly ?? 0;
const nameOf = (plans: Plan[], id: string | null) => plans.find((p) => p.id === id)?.name ?? id ?? 'unknown';
const hourCost = (plans: Plan[], plan: string | null, hours: number) => (priceOf(plans, plan) * hours) / HOURS_PER_MONTH;

function planLines(plans: Plan[], rows: { plan: string | null; hours: number }[]): UsagePlanLine[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.plan ?? 'unknown', (by.get(r.plan ?? 'unknown') ?? 0) + r.hours);
  const order = (p: string) => { const i = plans.findIndex((x) => x.id === p); return i < 0 ? plans.length : i; };
  return [...by].sort((a, b) => order(a[0]) - order(b[0])).map(([plan, hours]) => ({
    plan, planName: nameOf(plans, plan), hours: round(hours), estimatedCost: round(hourCost(plans, plan, hours)),
  }));
}

interface PeriodRow { kind: string; resource_id: string; plan: string | null; hours: number; gb_hours: number }

export async function usageReport(workspaceId: string, month: string, now = new Date()): Promise<UsageReport> {
  const range = monthRange(month);
  if (!range) throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
  const { start, end } = range;
  // Usage runs up to now in the current month; future months are empty.
  const until = new Date(Math.max(start.getTime(), Math.min(end.getTime(), now.getTime())));
  const params = [workspaceId, start.toISOString(), end.toISOString(), until.toISOString()];

  // Spans overlapping [start, end): the expression index on (workspace_id, COALESCE(ended_at, 'infinity')) skips
  // everything that ended before the month; open spans run up to `until`.
  const overlap = `GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(ended_at, $4::timestamptz), $4::timestamptz) - GREATEST(started_at, $2::timestamptz))) / 3600.0`;
  const [periods, bandwidth, daily, resources] = await Promise.all([
    q<PeriodRow>(
      `SELECT kind, resource_id, plan, sum(${overlap})::float8 AS hours, sum(${overlap} * quantity)::float8 AS gb_hours
       FROM usage_periods
       WHERE workspace_id = $1 AND COALESCE(ended_at, 'infinity'::timestamptz) > $2::timestamptz AND started_at < $3::timestamptz
       GROUP BY 1, 2, 3`,
      params,
    ),
    q<{ service_id: string; bytes: number }>(
      `SELECT service_id, sum(bytes_out)::bigint AS bytes FROM usage_bandwidth_daily
       WHERE workspace_id = $1 AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date AND day < ($3::timestamptz AT TIME ZONE 'UTC')::date
       GROUP BY 1`,
      params.slice(0, 3),
    ),
    // Per-day instance hours: each day of the month (up to now) against the instance spans overlapping it.
    q<{ day: string; instance_hours: number; bytes: number }>(
      `WITH days AS (
         SELECT d AT TIME ZONE 'UTC' AS day_start, (d + interval '1 day') AT TIME ZONE 'UTC' AS day_end
         FROM generate_series($2::timestamptz AT TIME ZONE 'UTC', ($3::timestamptz AT TIME ZONE 'UTC') - interval '1 microsecond', interval '1 day') AS d
       ), spans AS (
         SELECT started_at, LEAST(COALESCE(ended_at, $3::timestamptz), $3::timestamptz) AS ended_at FROM usage_periods
         WHERE workspace_id = $1 AND kind = 'instance' AND COALESCE(ended_at, 'infinity'::timestamptz) > $2::timestamptz AND started_at < $3::timestamptz
       )
       SELECT to_char(days.day_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         COALESCE((SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM LEAST(s.ended_at, days.day_end) - GREATEST(s.started_at, days.day_start))))
                   FROM spans s WHERE s.started_at < days.day_end AND s.ended_at > days.day_start), 0)::float8 / 3600.0 AS instance_hours,
         COALESCE((SELECT sum(b.bytes_out) FROM usage_bandwidth_daily b
                   WHERE b.workspace_id = $1 AND b.day = (days.day_start AT TIME ZONE 'UTC')::date), 0)::bigint AS bytes
       FROM days ORDER BY 1`,
      [workspaceId, start.toISOString(), until.toISOString()],
    ),
    q<{ id: string; kind: string; name: string; type: string | null; deleted: boolean }>(
      'SELECT id, kind, name, type, deleted_at IS NOT NULL AS deleted FROM usage_resources WHERE workspace_id = $1',
      [workspaceId],
    ),
  ]);

  const res = new Map(resources.map((r) => [r.id, r]));
  const label = (id: string) => ({ name: res.get(id)?.name ?? id, deleted: res.get(id)?.deleted ?? true });
  const of = (kind: string) => periods.filter((p) => p.kind === kind);
  const bwBy = new Map(bandwidth.map((b) => [b.service_id, Number(b.bytes)]));

  // Services: every service with any usage this month.
  const serviceIds = new Set([...periods.filter((p) => ['instance', 'disk', 'build'].includes(p.kind)).map((p) => p.resource_id), ...bwBy.keys()]);
  const services = [...serviceIds].map((id) => {
    const mine = periods.filter((p) => p.resource_id === id);
    const inst = mine.filter((p) => p.kind === 'instance');
    const diskGBMonths = mine.filter((p) => p.kind === 'disk').reduce((a, p) => a + p.gb_hours, 0) / HOURS_PER_MONTH;
    const instanceCost = inst.reduce((a, p) => a + hourCost(SERVICE_PLANS, p.plan, p.hours), 0);
    return {
      id, ...label(id), type: res.get(id)?.type ?? null,
      instanceHours: round(inst.reduce((a, p) => a + p.hours, 0)),
      plans: planLines(SERVICE_PLANS, inst),
      bandwidthBytes: bwBy.get(id) ?? 0,
      buildMinutes: round(mine.filter((p) => p.kind === 'build').reduce((a, p) => a + p.hours, 0) * 60, 1),
      diskGBMonths: round(diskGBMonths, 3),
      estimatedCost: round(instanceCost + diskGBMonths * DISK_PRICE_GB_MONTH),
    };
  }).sort((a, b) => b.estimatedCost - a.estimatedCost || b.instanceHours - a.instanceHours || a.name.localeCompare(b.name));

  const byResource = (kind: string, plans: Plan[]) => {
    const ids = [...new Set(of(kind).map((p) => p.resource_id))];
    return ids.map((id) => {
      const mine = of(kind).filter((p) => p.resource_id === id);
      return {
        id, ...label(id),
        hours: round(mine.reduce((a, p) => a + p.hours, 0)),
        plans: planLines(plans, mine),
        storageGBMonths: round(mine.reduce((a, p) => a + p.gb_hours, 0) / HOURS_PER_MONTH, 3),
        estimatedCost: round(mine.reduce((a, p) => a + hourCost(plans, p.plan, p.hours), 0)),
      };
    }).sort((a, b) => b.estimatedCost - a.estimatedCost || b.hours - a.hours || a.name.localeCompare(b.name));
  };
  const databases = byResource('database', DATABASE_PLANS);
  const keyValues = byResource('key_value', KEY_VALUE_PLANS).map(({ storageGBMonths: _, ...kv }) => kv);

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  return {
    month,
    start: start.toISOString(),
    end: end.toISOString(),
    partial: now < end,
    generatedAt: now.toISOString(),
    disclaimer: USAGE_DISCLAIMER,
    totals: {
      instanceHours: round(sum(of('instance'), (p) => p.hours)),
      bandwidthBytes: sum(bandwidth, (b) => Number(b.bytes)),
      buildMinutes: round(sum(of('build'), (p) => p.hours) * 60, 1),
      diskGBMonths: round(sum(of('disk'), (p) => p.gb_hours) / HOURS_PER_MONTH, 3),
      databaseHours: round(sum(of('database'), (p) => p.hours)),
      keyValueHours: round(sum(of('key_value'), (p) => p.hours)),
      estimatedCost: round(sum(services, (s) => s.estimatedCost) + sum(databases, (d) => d.estimatedCost) + sum(keyValues, (k) => k.estimatedCost)),
    },
    instanceHoursByPlan: planLines(SERVICE_PLANS, of('instance')),
    databaseHoursByPlan: planLines(DATABASE_PLANS, of('database')),
    keyValueHoursByPlan: planLines(KEY_VALUE_PLANS, of('key_value')),
    services,
    databases,
    keyValues,
    daily: daily.map((d) => ({ day: d.day, instanceHours: round(d.instance_hours, 3), bandwidthBytes: Number(d.bytes) })),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per resource and plan, plus a total row. */
export function usageCsv(r: UsageReport): string {
  const head = ['month', 'resource_type', 'resource_id', 'name', 'deleted', 'plan', 'hours', 'bandwidth_bytes', 'build_minutes', 'disk_gb_months', 'estimated_cost_usd'];
  const rows: unknown[][] = [];
  for (const s of r.services) {
    const plans = s.plans.length ? s.plans : [null];
    plans.forEach((p, i) => rows.push([
      r.month, `service:${s.type ?? 'unknown'}`, s.id, s.name, s.deleted, p?.plan ?? '', p?.hours ?? 0,
      // Bandwidth, builds and disk are per service: on its first plan row only.
      i === 0 ? s.bandwidthBytes : '', i === 0 ? s.buildMinutes : '', i === 0 ? s.diskGBMonths : '',
      i === 0 ? s.estimatedCost : '',
    ]));
  }
  for (const d of r.databases) {
    d.plans.forEach((p, i) => rows.push([r.month, 'postgres', d.id, d.name, d.deleted, p.plan, p.hours, '', '', i === 0 ? d.storageGBMonths : '', p.estimatedCost]));
  }
  for (const k of r.keyValues) {
    k.plans.forEach((p) => rows.push([r.month, 'key_value', k.id, k.name, k.deleted, p.plan, p.hours, '', '', '', p.estimatedCost]));
  }
  const t = r.totals;
  rows.push([r.month, 'total', '', `Total (${r.disclaimer})`, '', '', round(t.instanceHours + t.databaseHours + t.keyValueHours), t.bandwidthBytes, t.buildMinutes, t.diskGBMonths, t.estimatedCost]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
