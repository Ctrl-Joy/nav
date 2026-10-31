const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });

export function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  const d = toDate(value);
  if (!d) return '—';
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 10) return 'just now';
  for (const [unit, secs] of UNITS) {
    if (abs >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
  }
  return d.toLocaleString();
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "42s", "3m 05s", "1h 02m" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const a = toDate(start);
  if (!a) return null;
  const b = toDate(end) ?? new Date();
  return b.getTime() - a.getTime();
}
