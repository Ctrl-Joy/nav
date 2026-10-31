import type { LogLine } from '@nav/shared';
import { parseCommandArgs, pick } from '../args.ts';
import { ApiError, UsageError, errorMessage } from '../errors.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext, type WorkspaceContext } from '../context.ts';
import type { Query } from '../api.ts';
import { LOG_LEVELS, LOG_STREAMS } from '../status.ts';
import { isAbortError, sleep, trapInterrupt } from '../signal.ts';
import { clock, dim, err, gray, out, padCell, printJson, red, yellow } from '../output.ts';

const LOG_USAGE = 'nav logs <service> [--tail] [--stream build,runtime] [--level LEVEL] [--search TEXT] [--limit N] [--json]';

// Parses one SSE data payload into a log line, or null when it is not one.
export function parseLogLine(data: string): LogLine | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const line = value as Partial<LogLine>;
  if (typeof line.id !== 'number' || typeof line.message !== 'string') return null;
  return line as LogLine;
}

function levelCell(level: string): string {
  const text = padCell(level.toUpperCase(), 5);
  switch (level) {
    case 'error': return red(text);
    case 'warn': return yellow(text);
    case 'debug': return gray(text);
    default: return text;
  }
}

export function formatLogLine(line: LogLine): string {
  const stream = dim(padCell(line.stream, 7));
  return `${dim(clock(line.ts))}  ${levelCell(line.level)}  ${stream}  ${line.message}`;
}

function emitter(json: boolean): (line: LogLine) => void {
  if (json) return (line) => out(JSON.stringify(line));
  return (line) => out(formatLogLine(line));
}

// Follows new log lines over SSE, resuming with ?after= and reconnecting after drops.
async function followLogs(
  ctx: WorkspaceContext,
  serviceId: string,
  base: Query,
  lastId: number | undefined,
  emit: (line: LogLine) => void,
): Promise<void> {
  const interrupt = trapInterrupt();
  let last = lastId;
  let failures = 0;
  try {
    while (!interrupt.signal.aborted) {
      try {
        const stream = ctx.client.stream(`/services/${serviceId}/logs/stream`, { ...base, after: last }, interrupt.signal);
        for await (const message of stream) {
          const line = parseLogLine(message.data);
          if (!line) continue;
          if (last !== undefined && line.id <= last) continue;
          last = line.id;
          failures = 0;
          emit(line);
        }
        // The server closed the stream; reconnect shortly.
        await sleep(1000, interrupt.signal);
      } catch (error) {
        if (interrupt.signal.aborted || isAbortError(error)) break;
        if (error instanceof ApiError && error.status < 500 && error.status !== 429) throw error;
        failures++;
        if (failures > 5) throw error;
        err(dim(`connection lost (${errorMessage(error)}); retrying`));
        await sleep(Math.min(1000 * 2 ** failures, 15000), interrupt.signal);
      }
    }
    if (interrupt.signal.aborted) process.exitCode = 130;
  } finally {
    interrupt.dispose();
  }
}

async function logs(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    tail: { type: 'boolean', short: 'f' },
    stream: { type: 'string' },
    level: { type: 'string' },
    search: { type: 'string' },
    limit: { type: 'string' },
  });
  const ref = args.arg(0, 'service', LOG_USAGE);
  args.maxPositionals(1, LOG_USAGE);

  const streams = args.str('stream')?.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of streams ?? []) pick('--stream', s, LOG_STREAMS);
  const level = args.str('level');
  if (level !== undefined) pick('--level', level, LOG_LEVELS);
  const limit = args.int('limit') ?? 200;
  if (limit < 1 || limit > 1000) throw new UsageError('--limit must be between 1 and 1000');

  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const base: Query = {
    stream: streams && streams.length > 0 ? streams.join(',') : undefined,
    level,
    q: args.str('search'),
    limit,
  };
  const json = args.bool('json');
  const initial = await ctx.client.get<{ items: LogLine[] }>(`/services/${svc.id}/logs`, base);
  const emit = emitter(json);

  if (!args.bool('tail')) {
    if (json) {
      printJson(initial.items);
    } else if (initial.items.length === 0) {
      out(dim('No log lines match.'));
    } else {
      for (const line of initial.items) emit(line);
    }
    return;
  }

  let lastId: number | undefined;
  for (const line of initial.items) {
    emit(line);
    lastId = lastId === undefined ? line.id : Math.max(lastId, line.id);
  }
  await followLogs(ctx, svc.id, base, lastId, emit);
}

export const logCommands: CommandDef[] = [
  {
    name: 'logs',
    summary: 'Show or follow service logs',
    usage: [
      LOG_USAGE,
      'With --tail, --json prints one JSON object per line. Ctrl+C stops following.',
    ],
    run: logs,
  },
];
