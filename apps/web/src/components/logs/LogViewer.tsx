import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ChevronsUp } from 'lucide-react';
import type { LogLine } from '@nav/shared';
import type { StreamState } from '@/api/sse';
import { parseAnsi } from '@/lib/ansi';
import { cn } from '@/lib/cn';
import { escapeRegExp } from '@/lib/misc';
import { formatTime } from '@/lib/time';
import { Button, Spinner } from '@/components/ui/Button';

const ROW_H = 20;
const OVERSCAN = 30;

const LEVEL_CLASS: Record<LogLine['level'], string> = {
  debug: 'text-[#6b7584]',
  info: 'text-[#d6dde6]',
  warn: 'text-[#f5c46b]',
  error: 'text-[#ff8a8a]',
};

const STREAM_CLASS: Record<LogLine['stream'], string> = {
  build: 'text-[#f5b740]',
  deploy: 'text-[#6aa8ff]',
  runtime: 'text-[#3ddc84]',
  cron: 'text-[#c792ea]',
  job: 'text-[#c792ea]',
  system: 'text-[#2ee6f6]',
};

function Highlighted({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>;
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))}
    </>
  );
}

const Row = memo(function Row({
  line,
  re,
  showStream,
  showInstance,
}: {
  line: LogLine;
  re: RegExp | null;
  showStream: boolean;
  showInstance: boolean;
}) {
  const segments = useMemo(() => parseAnsi(line.message), [line.message]);
  return (
    <div className="log-line flex h-5 items-center gap-3 px-3 whitespace-pre hover:bg-white/[0.035]" style={{ height: ROW_H }}>
      <span className="shrink-0 text-[#5b6472] select-none">{formatTime(line.ts)}</span>
      {showStream && <span className={cn('w-14 shrink-0 select-none', STREAM_CLASS[line.stream])}>{line.stream}</span>}
      {showInstance && (
        <span className="w-20 shrink-0 truncate text-[#5b6472] select-none" title={line.instanceId ?? ''}>
          {line.instanceId ? line.instanceId.slice(-8) : '—'}
        </span>
      )}
      <span className={LEVEL_CLASS[line.level]}>
        {segments.map((s, i) => {
          const styled = s.fg || s.bg || s.bold || s.dim || s.italic || s.underline;
          if (!styled) return <Highlighted key={i} text={s.text} re={re} />;
          return (
            <span
              key={i}
              style={{
                color: s.fg,
                background: s.bg,
                fontWeight: s.bold ? 600 : undefined,
                opacity: s.dim ? 0.65 : undefined,
                fontStyle: s.italic ? 'italic' : undefined,
                textDecoration: s.underline ? 'underline' : undefined,
              }}
            >
              <Highlighted text={s.text} re={re} />
            </span>
          );
        })}
      </span>
    </div>
  );
});

export interface LogViewerProps {
  lines: LogLine[];
  highlight?: string;
  loading?: boolean;
  state?: StreamState;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  showStream?: boolean;
  showInstance?: boolean;
  height?: string;
  emptyText?: ReactNode;
  className?: string;
  label?: string;
}

/** Virtualised terminal-style log pane with follow mode that pauses when you scroll up. */
export function LogViewer({
  lines,
  highlight,
  loading,
  state,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  showStream = false,
  showInstance = false,
  height = 'h-[60vh]',
  emptyText = 'No log lines yet.',
  className,
  label = 'Logs',
}: LogViewerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [unseen, setUnseen] = useState(0);
  const prevFirst = useRef<number | undefined>(undefined);
  const prevLen = useRef(0);

  const re = useMemo(() => (highlight && highlight.trim() ? new RegExp(`(${escapeRegExp(highlight.trim())})`, 'gi') : null), [highlight]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = lines[0]?.id;
    // older lines were prepended: keep the viewport anchored
    if (prevFirst.current !== undefined && first !== undefined && first < prevFirst.current) {
      const idx = lines.findIndex((l) => l.id === prevFirst.current);
      if (idx > 0) el.scrollTop += idx * ROW_H;
    } else if (follow) {
      el.scrollTop = el.scrollHeight;
    } else if (lines.length > prevLen.current) {
      setUnseen((n) => n + (lines.length - prevLen.current));
    }
    prevFirst.current = first;
    prevLen.current = lines.length;
  }, [lines, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 1.5;
    if (atBottom !== follow) setFollow(atBottom);
    if (atBottom) setUnseen(0);
  };

  const jump = () => {
    setFollow(true);
    setUnseen(0);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = lines.slice(start, end);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-border bg-[#0a0c0f] font-mono text-[12px] leading-5 text-[#d6dde6]', className)}>
      {state && (
        <div className="absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-[#8b95a3] backdrop-blur">
          <span
            className={cn(
              'size-1.5 rounded-full',
              state === 'open' ? 'animate-pulse-dot bg-[#3ddc84]' : state === 'closed' ? 'bg-[#6b7584]' : 'bg-[#f5b740]',
            )}
          />
          {state === 'open' ? 'Live' : state === 'closed' ? 'Paused' : state === 'connecting' ? 'Connecting' : 'Reconnecting'}
        </div>
      )}
      <div ref={ref} onScroll={onScroll} className={cn('overflow-auto', height)} role="log" aria-label={label} aria-live="off" tabIndex={0}>
        {hasOlder && onLoadOlder && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-[#8b95a3] hover:bg-white/5 hover:text-white"
            >
              {loadingOlder ? <Spinner className="size-3" /> : <ChevronsUp className="size-3" />}
              Load older
            </button>
          </div>
        )}
        {loading && !lines.length ? (
          <div className="flex items-center gap-2 p-4 text-[#8b95a3]">
            <Spinner /> Loading logs…
          </div>
        ) : !lines.length ? (
          <div className="p-4 text-[#6b7584]">{emptyText}</div>
        ) : (
          <div className="min-w-max py-1" style={{ height: lines.length * ROW_H + 8, position: 'relative' }}>
            <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
              {visible.map((l) => (
                <Row key={l.id} line={l} re={re} showStream={showStream} showInstance={showInstance} />
              ))}
            </div>
          </div>
        )}
      </div>
      {!follow && lines.length > 0 && (
        <Button size="sm" variant="primary" className="absolute right-4 bottom-4 shadow-pop" icon={<ArrowDown className="size-3.5" />} onClick={jump}>
          {unseen > 0 ? `${unseen} new line${unseen === 1 ? '' : 's'}` : 'Jump to latest'}
        </Button>
      )}
    </div>
  );
}
