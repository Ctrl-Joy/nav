// Terminal output helpers: ANSI colors (off when not a TTY or NO_COLOR is set), aligned tables,
// relative times and small charts.

export interface TTYLike {
  isTTY?: boolean;
}

const CODES = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  magenta: '35',
  cyan: '36',
  gray: '90',
} as const;

export type Style = keyof typeof CODES;

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function colorEnabled(stream: TTYLike = process.stdout): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return stream.isTTY === true;
}

export function paint(text: string, style: Style, stream: TTYLike = process.stdout): string {
  return colorEnabled(stream) ? `\u001b[${CODES[style]}m${text}\u001b[0m` : text;
}

export const bold = (text: string): string => paint(text, 'bold');
export const dim = (text: string): string => paint(text, 'dim');
export const green = (text: string): string => paint(text, 'green');
export const red = (text: string): string => paint(text, 'red');
export const yellow = (text: string): string => paint(text, 'yellow');
export const cyan = (text: string): string => paint(text, 'cyan');
export const gray = (text: string): string => paint(text, 'gray');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export type Align = 'left' | 'right';

export function padCell(text: string, width: number, align: Align = 'left'): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
}

export interface TableOptions {
  align?: Align[];
}

// Renders headers (upper-cased) and rows as aligned columns separated by two spaces.
// Cell widths ignore ANSI escape sequences, so colored cells line up.
export function table(headers: string[], rows: string[][], opts: TableOptions = {}): string {
  const heads = headers.map((h) => h.toUpperCase());
  const alignOf = (i: number): Align => opts.align?.[i] ?? 'left';
  const cellAt = (row: string[], i: number): string => row[i] ?? '';
  const widths = heads.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(cellAt(r, i)))));
  const renderRow = (cells: string[], paintCell: (s: string) => string): string => {
    const last = heads.length - 1;
    return heads
      .map((_, i) => {
        const text = paintCell(cellAt(cells, i));
        if (i === last && alignOf(i) === 'left') return text;
        return padCell(text, widths[i] ?? 0, alignOf(i));
      })
      .join('  ')
      .trimEnd();
  };
  const lines = [renderRow(heads, bold), ...rows.map((r) => renderRow(r, (s) => s))];
  return lines.join('\n');
}

// Aligned "Key   value" lines. Null or undefined values print as "-".
export function kv(pairs: Array<[string, string | null | undefined]>): string {
  if (pairs.length === 0) return '';
  const width = Math.max(...pairs.map(([key]) => visibleWidth(key)));
  return pairs.map(([key, value]) => `${dim(padCell(key, width))}  ${value ?? '-'}`).join('\n');
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '-';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const diffSeconds = (now - time) / 1000;
  const future = diffSeconds < 0;
  const seconds = Math.floor(Math.abs(diffSeconds));
  if (seconds < 45) return 'just now';
  let unit: string;
  if (seconds < 3600) unit = `${Math.round(seconds / 60)}m`;
  else if (seconds < 86400) unit = `${Math.round(seconds / 3600)}h`;
  else if (seconds < 30 * 86400) unit = `${Math.round(seconds / 86400)}d`;
  else return new Date(time).toISOString().slice(0, 10);
  return future ? `in ${unit}` : `${unit} ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Elapsed time between two ISO timestamps; an open end uses the current time.
export function durationBetween(start: string | null | undefined, end: string | null | undefined, now = Date.now()): string {
  if (!start) return '-';
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  if (Number.isNaN(from) || Number.isNaN(to)) return '-';
  return formatDuration(Math.max(0, to - from));
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return BARS[3].repeat(values.length);
  return values
    .map((v) => BARS[Math.round(((v - min) / (max - min)) * (BARS.length - 1))] ?? BARS[0])
    .join('');
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const GOOD_STATUSES = new Set([
  'live', 'healthy', 'available', 'succeeded', 'completed', 'in_sync', 'verified', 'issued', 'deactivated',
]);
const PENDING_STATUSES = new Set([
  'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress', 'deploying', 'creating',
  'pending', 'running', 'starting', 'syncing', 'restoring', 'unverified', 'issuing', 'draining',
]);
const BAD_STATUSES = new Set([
  'failed', 'build_failed', 'pre_deploy_failed', 'update_failed', 'crashed', 'unhealthy', 'error',
]);
const MUTED_STATUSES = new Set(['suspended', 'sleeping', 'canceled', 'stopped', 'deleting', 'created']);

export function statusText(status: string): string {
  if (GOOD_STATUSES.has(status)) return green(status);
  if (PENDING_STATUSES.has(status)) return yellow(status);
  if (BAD_STATUSES.has(status)) return red(status);
  if (MUTED_STATUSES.has(status)) return gray(status);
  return status;
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '-';
}

export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
