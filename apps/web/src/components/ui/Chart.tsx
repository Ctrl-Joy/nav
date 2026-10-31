import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface ChartSeries {
  name: string;
  data: [string, number][];
  color?: string;
}

export interface ChartProps {
  series: ChartSeries[];
  height?: number;
  format?: (v: number) => string;
  limit?: { value: number; label: string };
  area?: boolean;
  className?: string;
  ariaLabel: string;
}

const PALETTE = ['var(--accent)', 'var(--info)', 'var(--warning)', 'var(--success)', 'var(--danger)'];
const PAD = { top: 10, right: 12, bottom: 22, left: 46 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs > 2 * 24 * 3600_000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Hand-rolled responsive SVG area/line chart with crosshair tooltip and keyboard scrubbing. */
export function Chart({ series, height = 160, format = (v) => `${+v.toFixed(2)}`, limit, area = true, className, ariaLabel }: ChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');

  const model = useMemo(() => {
    const parsed = series.map((s, i) => ({
      name: s.name,
      color: s.color ?? PALETTE[i % PALETTE.length],
      points: s.data.map(([t, v]) => [new Date(t).getTime(), Number.isFinite(v) ? v : 0] as [number, number]).filter(([t]) => Number.isFinite(t)),
    }));
    const all = parsed.flatMap((s) => s.points);
    if (!all.length) return null;
    const xMin = Math.min(...all.map((p) => p[0]));
    const xMax = Math.max(...all.map((p) => p[0]));
    const yMax = niceMax(Math.max(...all.map((p) => p[1]), limit?.value ?? 0) * 1.08);
    const base = parsed.reduce((a, b) => (b.points.length > a.points.length ? b : a), parsed[0]);
    return { parsed, xMin, xMax: xMax === xMin ? xMin + 1 : xMax, yMax, times: base.points.map((p) => p[0]) };
  }, [series, limit?.value]);

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;

  if (!model) {
    return (
      <div ref={wrapRef} className={cn('flex items-center justify-center text-xs text-fg-subtle', className)} style={{ height }}>
        No data in this range yet
      </div>
    );
  }

  const x = (t: number) => PAD.left + ((t - model.xMin) / (model.xMax - model.xMin)) * innerW;
  const y = (v: number) => PAD.top + innerH - (v / model.yMax) * innerH;
  const span = model.xMax - model.xMin;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * model.yMax);
  const xTickCount = Math.max(2, Math.min(6, Math.floor(innerW / 90)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => model.xMin + (span * i) / (xTickCount - 1));

  const hoverT = hover != null ? model.times[hover] : null;
  const nearest = (pts: [number, number][], t: number) => {
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best;
  };

  const onMove = (clientX: number, rect: DOMRect) => {
    const t = model.xMin + ((clientX - rect.left - PAD.left) / innerW) * span;
    let idx = 0;
    for (let i = 0; i < model.times.length; i++) if (Math.abs(model.times[i] - t) < Math.abs(model.times[idx] - t)) idx = i;
    setHover(idx);
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const n = model.times.length;
    setHover((h) => {
      const cur = h ?? (e.key === 'ArrowLeft' ? n : -1);
      return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    });
  };

  const tooltipLeft = hoverT != null ? x(hoverT) : 0;

  return (
    <div ref={wrapRef} className={cn('relative select-none', className)} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          <defs>
            {model.parsed.map((s, i) => (
              <linearGradient key={i} id={`${gid}-g${i}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={i === 0 ? undefined : '2 4'} />
              <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-fg-subtle font-mono text-[10px]">
                {format(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={x(t)}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
              className="fill-fg-subtle font-mono text-[10px]"
            >
              {timeLabel(t, span)}
            </text>
          ))}
          {model.parsed.map((s, i) => {
            if (!s.points.length) return null;
            const line = s.points.map((p, j) => `${j ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
            const areaPath = `${line}L${x(s.points[s.points.length - 1][0]).toFixed(1)},${y(0)}L${x(s.points[0][0]).toFixed(1)},${y(0)}Z`;
            return (
              <g key={s.name}>
                {area && <path d={areaPath} fill={`url(#${gid}-g${i})`} />}
                <path d={line} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {limit && limit.value > 0 && (
            <g>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(limit.value)} y2={y(limit.value)} stroke="var(--danger)" strokeDasharray="5 4" strokeOpacity={0.7} />
              <text x={width - PAD.right} y={y(limit.value) - 4} textAnchor="end" className="fill-danger text-[10px]">
                {limit.label}
              </text>
            </g>
          )}
          {hoverT != null && (
            <g>
              <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--fg-subtle)" strokeDasharray="3 3" />
              {model.parsed.map((s) => {
                if (!s.points.length) return null;
                const p = nearest(s.points, hoverT);
                return <circle key={s.name} cx={x(p[0])} cy={y(p[1])} r={3.5} fill="var(--bg)" stroke={s.color} strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
      )}
      {hoverT != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border bg-bg-elevated px-2.5 py-2 text-xs shadow-pop"
          style={{
            left: Math.min(Math.max(tooltipLeft + 12, 0), Math.max(0, width - 170)),
          }}
          role="status"
        >
          <div className="mb-1 font-mono text-[10.5px] text-fg-subtle">{new Date(hoverT).toLocaleString()}</div>
          {model.parsed.map((s) =>
            s.points.length ? (
              <div key={s.name} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-fg-muted">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} />
                  {s.name}
                </span>
                <span className="font-mono text-fg">{format(nearest(s.points, hoverT)[1])}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** Tiny inline sparkline (no axes). */
export function Sparkline({ data, color = 'var(--accent)', width = 96, height = 24 }: { data: number[]; color?: string; width?: number; height?: number }) {
  if (data.length < 2) return <svg width={width} height={height} aria-hidden />;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * width).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`);
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
