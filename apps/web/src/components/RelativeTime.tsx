import { useEffect, useState } from 'react';
import { formatDateTime, relativeTime } from '@/lib/time';

let subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (!timer) timer = setInterval(() => subscribers.forEach((f) => f()), 30_000);
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && timer) {
      clearInterval(timer);
      timer = undefined;
      subscribers = new Set();
    }
  };
}

/** Self-updating relative timestamp with the absolute time as tooltip. */
export function RelativeTime({ value, className }: { value: string | null | undefined; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => subscribe(() => tick((n) => n + 1)), []);
  if (!value) return <span className={className}>—</span>;
  return (
    <time dateTime={value} title={formatDateTime(value)} className={className}>
      {relativeTime(value)}
    </time>
  );
}

/** Ticking elapsed timer for in-progress work. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}
