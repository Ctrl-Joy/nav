// Human-readable descriptions for 5-field cron expressions (UTC).

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface CronResult {
  valid: boolean;
  description: string;
  error?: string;
}

function validField(field: string, [min, max]: [number, number]): boolean {
  return field.split(',').every((part) => {
    const [range, step] = part.split('/');
    if (step !== undefined && !/^\d+$/.test(step)) return false;
    if (range === '*') return true;
    const bounds = range.split('-');
    if (bounds.length > 2) return false;
    return bounds.every((b) => /^\d+$/.test(b) && +b >= min && +b <= max);
  });
}

function pad(n: string | number): string {
  return String(n).padStart(2, '0');
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function listNames(field: string, names: string[], offset: number): string {
  return field
    .split(',')
    .map((p) => {
      if (p.includes('-')) {
        const [a, b] = p.split('-').map(Number);
        return `${names[(a - offset) % names.length]} through ${names[(b - offset) % names.length]}`;
      }
      return names[(Number(p) - offset) % names.length];
    })
    .join(', ');
}

export function describeCron(expr: string): CronResult {
  const raw = expr.trim();
  if (!raw) return { valid: false, description: '', error: 'Enter a schedule' };
  const normalized = ALIASES[raw.toLowerCase()] ?? raw;
  const f = normalized.split(/\s+/);
  if (f.length !== 5) return { valid: false, description: '', error: 'Expected 5 fields: minute hour day-of-month month day-of-week' };
  for (let i = 0; i < 5; i++) {
    if (!validField(f[i], RANGES[i])) return { valid: false, description: '', error: `Invalid ${['minute', 'hour', 'day-of-month', 'month', 'day-of-week'][i]} field "${f[i]}"` };
  }
  const [min, hour, dom, mon, dow] = f;
  let time: string;
  const minStep = min.match(/^\*\/(\d+)$/);
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (min === '*' && hour === '*') time = 'Every minute';
  else if (minStep && hour === '*') time = `Every ${minStep[1]} minutes`;
  else if (/^\d+$/.test(min) && hour === '*') time = min === '0' ? 'Every hour, on the hour' : `Every hour at :${pad(min)}`;
  else if (/^\d+$/.test(min) && hourStep) time = `Every ${hourStep[1]} hours at :${pad(min)}`;
  else if (/^\d+$/.test(min) && /^\d+$/.test(hour)) time = `At ${pad(hour)}:${pad(min)} UTC`;
  else if (/^\d+$/.test(min) && /^[\d,]+$/.test(hour)) time = `At ${hour.split(',').map((h) => `${pad(h)}:${pad(min)}`).join(', ')} UTC`;
  else time = `At minute ${min} past hour ${hour}`;

  const parts = [time];
  if (dom !== '*') {
    const d = /^\d+$/.test(dom) ? `on the ${ordinal(Number(dom))}` : `on day-of-month ${dom}`;
    parts.push(d);
  }
  if (mon !== '*') parts.push(/^[\d,-]+$/.test(mon) ? `in ${listNames(mon, MONTHS, 1)}` : `in month ${mon}`);
  if (dow !== '*') {
    if (dow === '1-5') parts.push('on weekdays');
    else if (dow === '0,6' || dow === '6,0') parts.push('on weekends');
    else parts.push(/^[\d,-]+$/.test(dow) ? `on ${listNames(dow, DOW, 0)}` : `on day-of-week ${dow}`);
  } else if (dom === '*' && mon === '*' && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    parts.push('every day');
  }
  return { valid: true, description: parts.join(', ') };
}

export const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 5 min', value: '*/5 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily 03:00', value: '0 3 * * *' },
  { label: 'Weekdays 09:00', value: '0 9 * * 1-5' },
  { label: 'Weekly (Sun)', value: '0 0 * * 0' },
  { label: 'Monthly', value: '0 0 1 * *' },
];
