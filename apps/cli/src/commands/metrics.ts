import type { MetricsResponse } from '@nav/shared';
import { parseCommandArgs, pick } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext } from '../context.ts';
import { METRIC_RANGES } from '../status.ts';
import { bold, bytes, out, printJson, sparkline, table } from '../output.ts';

const USAGE = 'nav metrics <service> [--range 1h|6h|24h|7d] [--json]';

type Series = Array<[string, number]>;

function latest(series: Series): number | null {
  const last = series[series.length - 1];
  return last ? last[1] : null;
}

function format(value: number | null, digits = 0): string {
  return value === null ? '-' : value.toFixed(digits);
}

function trend(series: Series): string {
  return sparkline(series.map(([, v]) => v));
}

async function metrics(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { range: { type: 'string' } });
  const ref = args.arg(0, 'service', USAGE);
  args.maxPositionals(1, USAGE);
  const range = args.str('range') ?? '1h';
  pick('--range', range, METRIC_RANGES);

  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const data = await ctx.client.get<MetricsResponse>(`/services/${svc.id}/metrics`, { range });
  if (args.bool('json')) {
    printJson(data);
    return;
  }

  const memoryLimit = data.memoryLimitMB > 0 ? ` / ${format(data.memoryLimitMB)} MB` : '';
  const cpuLimit = data.cpuLimit > 0 ? ` / ${format(data.cpuLimit, 2)} cores` : '';
  out(`${bold(svc.name)} ${range === '1h' ? 'last hour' : `last ${range}`}`);
  out(table(
    ['metric', 'latest', 'trend'],
    [
      ['CPU', `${format(latest(data.cpu), 2)}${cpuLimit}`, trend(data.cpu)],
      ['Memory', `${format(latest(data.memoryMB))} MB${memoryLimit}`, trend(data.memoryMB)],
      ['Instances', format(latest(data.instances)), trend(data.instances)],
      ['Requests', `${format(latest(data.requests))}/min`, trend(data.requests)],
      ['5xx errors', `${format(latest(data.errors5xx))}/min`, trend(data.errors5xx)],
      ['Latency', `${format(latest(data.latencyAvgMs))} ms avg`, trend(data.latencyAvgMs)],
      ['Bandwidth', bytes(latest(data.bandwidthBytes) ?? 0), trend(data.bandwidthBytes)],
    ],
  ));
}

export const metricsCommands: CommandDef[] = [
  {
    name: 'metrics',
    summary: 'Show the latest CPU, memory and request metrics with trends',
    usage: [USAGE],
    run: metrics,
  },
];
