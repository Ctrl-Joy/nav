import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlarmClock, ArrowRight, Bell, Check, ChevronDown, Copy, Eye, GitPullRequest, Globe, HardDrive, LayoutGrid, Loader2,
  Lock, Maximize2, Minus, Network, Pencil, Plus, RefreshCw, RotateCcw, ScrollText, Shield, Sparkles, Users, Workflow, Zap,
} from 'lucide-react';
import { LogoMark } from '@/components/Logo';
import './story.css';

/* ------------------------------------------------------------------------------------------------------------------
 * Scroll story: five chapters along a timeline rail. A dotted thumb travels down the rail with the scroll position and
 * takes the colour of the chapter in view. Every chapter pairs copy with a live product mock; mocks only animate while
 * on screen and hold a still frame under prefers-reduced-motion.
 * ---------------------------------------------------------------------------------------------------------------- */

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True while the element is (nearly) on screen. */
function useActive<T extends Element>(margin = '120px') {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, on] as const;
}

/** setInterval that only runs while `active` and motion is allowed. */
function useTick(fn: () => void, ms: number, active: boolean) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (!active || reduceMotion()) return;
    const id = window.setInterval(() => cb.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

/** Renders children at a fixed design size and scales them to the available width. */
function Scaled({ w, h, children, className }: { w: number; h?: number; children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(1);
  // Without a fixed `h`, the design height is measured from the content (offsetHeight ignores the scale transform).
  const [designH, setDesignH] = useState(h ?? 0);
  useLayoutEffect(() => {
    const el = outer.current;
    const content = inner.current;
    if (!el || !content) return;
    const fit = () => {
      setS(Math.min(1.15, el.clientWidth / w));
      if (h === undefined) setDesignH(content.offsetHeight);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <div ref={outer} className={className} style={{ height: designH * s, position: 'relative' }}>
      <div ref={inner} style={{ width: w, height: h, transform: `scale(${s})`, transformOrigin: 'top left', position: 'absolute', left: 0, top: 0 }}>{children}</div>
    </div>
  );
}

/* ---------------------------------------------- shared mock pieces ---------------------------------------------- */

type Badge = { t: string; c: string };
const B = {
  js: { t: 'JS', c: '#f7df1e' },
  go: { t: 'Go', c: '#4fc3f7' },
  py: { t: 'Py', c: '#6ea8ff' },
  bun: { t: 'Bn', c: '#f9c6a8' },
  pg: { t: 'PG', c: '#7ea6e0' },
  dot: { t: '', c: '#22c55e' },
} satisfies Record<string, Badge>;

function BadgeTile({ b, icon }: { b?: Badge; icon?: ReactNode }) {
  if (icon) return <span className="st-badge st-badge-icon">{icon}</span>;
  if (!b) return null;
  if (!b.t) return <span className="st-badge-dot" style={{ background: b.c }} />;
  return <span className="st-badge">{b.t}</span>;
}

/** Window chrome around the dashboard mocks: brand, project / environment, tabs, share. */
function Chrome({ project, tab, children }: { project: string; tab: 'Architecture' | 'Observability'; children: ReactNode }) {
  return (
    <div className="st-win">
      <div className="st-win-bar">
        <LogoMark className="h-[13px]" />
        <span className="st-crumb">/</span>
        <span>{project}</span>
        <span className="st-crumb">/</span>
        <span className="st-env">production <ChevronDown /></span>
        <nav className="st-tabs" aria-hidden="true">
          {(['Architecture', 'Observability', 'Logs', 'Settings'] as const).map((t) => <span key={t} className={t === tab ? 'on' : ''}>{t}</span>)}
        </nav>
        <span className="st-share">Share</span>
        <span className="st-avatar" />
      </div>
      {children}
    </div>
  );
}

/* --------------------------------------------- 1. architecture canvas -------------------------------------------- */

type Status = 'building' | 'deployed' | 'image' | 'online' | 'ready';
interface CanvasNode { id: string; x: number; y: number; name: string; badge?: Badge; icon?: ReactNode; url?: string; status: Status; next?: Status; foot?: { icon: ReactNode; text: string }; at: number }
interface Scene { project: string; nodes: CanvasNode[]; edges: [string, string, 'h' | 'v'][]; group?: { x: number; y: number; w: number; h: number; label: string } }

const NODE_W = 210;
const nodeH = (n: CanvasNode) => 30 + (n.url ? 20 : 0) + 34 + (n.foot ? 38 : 0) + 14;

const SCENES: Scene[] = [
  {
    project: 'storefront',
    nodes: [
      { id: 'web', x: 150, y: 70, name: 'web', badge: B.js, url: 'web.example.com', status: 'building', next: 'deployed', at: 0 },
      { id: 'api', x: 450, y: 70, name: 'api', badge: B.go, url: 'api.example.com', status: 'building', next: 'deployed', at: 350 },
      { id: 'worker', x: 450, y: 300, name: 'queue-worker', badge: B.py, status: 'building', next: 'deployed', at: 700 },
      { id: 'db', x: 750, y: 175, name: 'postgres', badge: B.pg, status: 'image', at: 1000, foot: { icon: <HardDrive />, text: 'pg-data' } },
    ],
    edges: [['web', 'api', 'h'], ['api', 'worker', 'v'], ['api', 'db', 'h'], ['worker', 'db', 'h']],
  },
  {
    project: 'checkout',
    nodes: [
      { id: 'fe', x: 400, y: 36, name: 'frontend', badge: B.js, url: 'shop.example.com', status: 'deployed', at: 0 },
      { id: 'an', x: 90, y: 215, name: 'analytics', badge: B.dot, url: 'stats.example.com', status: 'building', next: 'deployed', at: 400 },
      { id: 'gw', x: 400, y: 360, name: 'api gateway', badge: B.go, url: 'api.example.com', status: 'deployed', at: 200 },
      { id: 'be', x: 730, y: 60, name: 'backend', badge: B.py, status: 'building', next: 'deployed', at: 600, foot: { icon: <Copy />, text: '3 instances' } },
      { id: 'pg', x: 730, y: 300, name: 'postgres', badge: B.pg, status: 'image', at: 850, foot: { icon: <HardDrive />, text: 'pg-data' } },
    ],
    edges: [['an', 'fe', 'h'], ['fe', 'gw', 'v'], ['fe', 'be', 'h'], ['gw', 'pg', 'h'], ['be', 'pg', 'v']],
  },
  {
    project: 'reports',
    group: { x: 700, y: 26, w: 270, h: 478, label: 'private network' },
    nodes: [
      { id: 'cron', x: 90, y: 190, name: 'nightly-report', icon: <AlarmClock />, status: 'ready', at: 0, foot: { icon: <AlarmClock />, text: 'Next run in 2h' } },
      { id: 'web', x: 410, y: 60, name: 'web', badge: B.bun, url: 'reports.example.com', status: 'deployed', at: 250 },
      { id: 'q', x: 410, y: 320, name: 'queue-worker', icon: <Workflow />, status: 'building', next: 'deployed', at: 500 },
      { id: 'pg', x: 730, y: 76, name: 'postgres', badge: B.pg, status: 'image', at: 750, foot: { icon: <HardDrive />, text: 'pg-data' } },
      { id: 'srch', x: 730, y: 330, name: 'search', icon: <Lock />, status: 'online', at: 950 },
    ],
    edges: [['cron', 'q', 'h'], ['web', 'q', 'v'], ['web', 'pg', 'h'], ['q', 'srch', 'h']],
  },
];

function statusRow(s: Status) {
  switch (s) {
    case 'building': return <><Loader2 className="st-spin" /> Building…</>;
    case 'deployed': return <><Check className="st-ok" /> Deployed just now</>;
    case 'image': return <><Check className="st-ok" /> Deployed from image</>;
    case 'online': return <><Check className="st-ok" /> Online</>;
    case 'ready': return <><Check className="st-ok" /> Ready to run</>;
  }
}

function NodeCard({ n }: { n: CanvasNode }) {
  const [shown, setShown] = useState(reduceMotion());
  const [status, setStatus] = useState<Status>(reduceMotion() && n.next ? n.next : n.status);
  useEffect(() => {
    if (reduceMotion()) return;
    const a = window.setTimeout(() => setShown(true), n.at);
    const b = n.next ? window.setTimeout(() => setStatus(n.next!), n.at + 1700) : 0;
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [n]);
  return (
    <div className={`st-node${shown ? ' in' : ''}`} style={{ left: n.x, top: n.y, width: NODE_W }}>
      <div className="st-node-main">
        <div className="st-node-name"><BadgeTile b={n.badge} icon={n.icon} />{n.name}</div>
        {n.url && <div className="st-node-url">{n.url}</div>}
        <div className={`st-node-status${status === 'building' ? ' busy' : ''}`}>{statusRow(status)}</div>
      </div>
      {n.foot && <div className="st-node-foot">{n.foot.icon}{n.foot.text}</div>}
    </div>
  );
}

function edgePath(a: CanvasNode, b: CanvasNode, kind: 'h' | 'v') {
  if (kind === 'v') {
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + nodeH(a);
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return `M${x1} ${y1} V${mid} H${x2} V${y2}`;
  }
  const leftToRight = a.x < b.x;
  const x1 = leftToRight ? a.x + NODE_W : a.x;
  const x2 = leftToRight ? b.x : b.x + NODE_W;
  const y1 = a.y + 44;
  const y2 = b.y + 44;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} H${mid} V${y2} H${x2}`;
}

function CanvasScene({ scene }: { scene: Scene }) {
  const by = Object.fromEntries(scene.nodes.map((n) => [n.id, n]));
  const last = Math.max(...scene.nodes.map((n) => n.at));
  return (
    <div className="st-scene">
      {scene.group && (
        <div className="st-group" style={{ left: scene.group.x, top: scene.group.y, width: scene.group.w, height: scene.group.h }}>
          <span><Shield /> {scene.group.label}</span>
        </div>
      )}
      <svg className="st-edges" width="1000" height="530" aria-hidden="true" style={{ animationDelay: `${last + 250}ms` }}>
        {scene.edges.map(([a, b, k]) => <path key={a + b} d={edgePath(by[a], by[b], k)} />)}
      </svg>
      {scene.nodes.map((n) => <NodeCard key={n.id} n={n} />)}
    </div>
  );
}

function CanvasMock() {
  const [ref, active] = useActive<HTMLDivElement>();
  const [i, setI] = useState(0);
  const [leaving, setLeaving] = useState(false);
  useTick(() => {
    setLeaving(true);
    window.setTimeout(() => { setI((v) => (v + 1) % SCENES.length); setLeaving(false); }, 450);
  }, 6200, active);
  const scene = SCENES[i];
  return (
    <div ref={ref}>
      <Scaled w={1000} h={600} className="st-mock">
        <Chrome project={scene.project} tab="Architecture">
          <div className="st-canvas">
            <div className="st-tools" aria-hidden="true">
              <span><LayoutGrid /></span>
              <span className="st-tools-stack"><Plus /><Minus /><Maximize2 /></span>
            </div>
            <div className="st-actions" aria-hidden="true"><span><RefreshCw /> Sync</span><span><Plus /> Create</span></div>
            <div className={`st-scene-wrap${leaving ? ' out' : ''}`}><CanvasScene key={i} scene={scene} /></div>
          </div>
        </Chrome>
      </Scaled>
    </div>
  );
}

/* ---------------------------------------------- 2. private network ---------------------------------------------- */

function NetworkMock() {
  const [ref, active] = useActive<HTMLDivElement>();
  const particles = useMemo(
    () => Array.from({ length: 34 }, (_, i) => ({ x: 170 + ((i * 37) % 100), d: (i * 0.173) % 1.6, up: i % 3 === 0, s: 3 + (i % 3) })),
    [],
  );
  return (
    <div ref={ref}>
      <Scaled w={440} h={520} className={`st-mock st-net${active ? ' run' : ''}`}>
        <div className="st-panel st-panel-net">
          <div className="st-card st-net-top">
            <div className="st-node-name"><BadgeTile b={B.dot} />analytics</div>
            <div className="st-node-url">internal: analytics:8080</div>
            <div className="st-node-status"><Check className="st-ok" /> Online</div>
          </div>
          <div className="st-flow" aria-hidden="true">
            {particles.map((p, i) => (
              <i key={i} className={p.up ? 'up' : ''} style={{ left: p.x, width: p.s, height: p.s, animationDelay: `${-p.d}s` }} />
            ))}
          </div>
          <div className="st-pill">
            <span className="st-pill-ok"><Check /></span>
            <b>TCP</b>:5432<em>Private</em><em>Encrypted</em><em>&lt;1 ms</em>
          </div>
          <div className="st-card st-net-bottom">
            <div className="st-node-name"><BadgeTile b={B.pg} />postgres</div>
            <div className="st-node-status"><Check className="st-ok" /> Online · internal only</div>
          </div>
        </div>
      </Scaled>
    </div>
  );
}

/* ------------------------------------------------- 3. scaling ------------------------------------------------- */

const SC_W = 240;
const SC_H = 112;
const SC_GAP_X = 16;
const SC_GAP_Y = 14;
const SC_ROW = 36;

/**
 * The loop, one frame every 700 ms. Act one scales vertically: a hardware tray of memory and CPU rows slides out
 * under the card, grows to three rows and folds away. Act two scales horizontally: copies slide out above and below,
 * side columns slide in from the edges, then everything collapses back into the single instance.
 */
const SCALE_FRAMES: { rows: number; layout: 'one' | 'col' | 'grid' }[] = [
  { rows: 0, layout: 'one' },
  { rows: 1, layout: 'one' },
  { rows: 2, layout: 'one' },
  { rows: 3, layout: 'one' },
  { rows: 3, layout: 'one' },
  { rows: 0, layout: 'one' },
  { rows: 0, layout: 'one' },
  { rows: 0, layout: 'col' },
  { rows: 0, layout: 'col' },
  { rows: 0, layout: 'grid' },
  { rows: 0, layout: 'grid' },
  { rows: 0, layout: 'grid' },
  { rows: 0, layout: 'one' },
  { rows: 0, layout: 'one' },
];

/** The eight replica slots around the original, as (row, column) offsets. */
const SC_SLOTS = [-1, 0, 1].flatMap((r) => [-1, 0, 1].map((c) => [r, c] as const)).filter(([r, c]) => r || c);

function ScaleCard({ style, className = '' }: { style?: CSSProperties; className?: string }) {
  return (
    <div className={`st-card st-sc-card ${className}`} style={style}>
      <div className="st-node-name"><BadgeTile b={B.js} />backend</div>
      <div className="st-node-status"><Check className="st-ok" /> Online</div>
    </div>
  );
}

function HardwareRow() {
  return (
    <div className="st-hw-row">
      {[0, 1].map((i) => <span key={`m${i}`} className="st-ram"><i /><i /><i /><i /><i /></span>)}
      {[0, 1, 2, 3].map((i) => <span key={`c${i}`} className="st-cpu" />)}
    </div>
  );
}

function ScaleMock() {
  const [ref, active] = useActive<HTMLDivElement>();
  const [k, setK] = useState(reduceMotion() ? 10 : 0);
  useTick(() => setK((v) => (v + 1) % SCALE_FRAMES.length), 700, active);
  const f = SCALE_FRAMES[k];
  const trayH = f.rows ? f.rows * SC_ROW + 6 : 0;
  return (
    <div ref={ref}>
      <Scaled w={440} h={520} className="st-mock">
        <div className="st-panel st-panel-scale">
          {/* Replicas start stacked behind the original and slide out to their slot. */}
          {SC_SLOTS.map(([r, c]) => {
            const shown = f.layout === 'grid' || (f.layout === 'col' && c === 0);
            return (
              <ScaleCard
                key={`${r}${c}`}
                className={shown ? 'on' : ''}
                style={{
                  transform: shown ? `translate(${c * (SC_W + SC_GAP_X)}px, ${r * (SC_H + SC_GAP_Y)}px)` : 'translate(0, 0) scale(0.88)',
                  zIndex: c === 0 ? 2 : 1,
                  transitionDelay: shown ? `${(Math.abs(r) + Math.abs(c)) * 60}ms` : '0ms',
                }}
              />
            );
          })}
          {/* The original, carrying the hardware tray; the pair stays centred as the tray grows. */}
          <div className="st-sc-group" style={{ transform: `translateY(${-trayH / 2}px)` }}>
            <ScaleCard className="on st-sc-main" />
            <div className="st-hw" style={{ height: trayH }} aria-hidden="true">
              {[0, 1, 2].map((i) => <HardwareRow key={i} />)}
            </div>
          </div>
        </div>
      </Scaled>
    </div>
  );
}

/* ----------------------------------------------- 4. observability ----------------------------------------------- */

const LOG_POOL: [string, string][] = [
  ['web', 'GET /api/cart 500 · upstream timed out after 30s'],
  ['api', 'Error: connect ECONNREFUSED 10.0.4.12:6379'],
  ['web', 'TypeError: Cannot read properties of undefined (reading "price")'],
  ['worker', 'job 4417 failed: payment provider returned 502'],
  ['api', 'POST /api/checkout 500 · deadlock detected on orders'],
  ['web', 'unhandled rejection: fetch failed (ETIMEDOUT)'],
  ['worker', 'retrying job 4417 (attempt 2 of 5)'],
  ['api', 'GET /api/users/91 404 · user not found'],
];

/** One live series: mean-reverting random walk with occasional bursts. */
interface SeriesSpec { name: string; color: string; mean: number; vol: number; burst?: number; drift?: number }
interface ChartSpec { title: string; unit: string; max: number; kind: 'line' | 'bars'; digits: number; series: SeriesSpec[] }

const CHARTS: ChartSpec[] = [
  { title: 'CPU', unit: '%', max: 80, kind: 'line', digits: 1, series: [
    { name: 'web', color: '#9466f8', mean: 34, vol: 5, burst: 22 },
    { name: 'worker', color: '#c4a5ff', mean: 17, vol: 3, burst: 12 },
  ] },
  { title: 'Memory', unit: ' MB', max: 512, kind: 'line', digits: 0, series: [
    { name: 'web', color: '#22c55e', mean: 384, vol: 7 },
    { name: 'worker', color: '#c4a5ff', mean: 236, vol: 6 },
  ] },
  { title: 'Requests', unit: '/s', max: 260, kind: 'line', digits: 0, series: [{ name: 'web', color: '#9466f8', mean: 118, vol: 14, burst: 90 }] },
  { title: 'Disk', unit: ' GB', max: 4, kind: 'line', digits: 2, series: [{ name: 'pg-data', color: '#a1a1aa', mean: 2.1, vol: 0.004, drift: 0.006 }] },
  { title: '5xx errors', unit: '/min', max: 12, kind: 'bars', digits: 0, series: [{ name: 'web', color: '#f87171', mean: 0.4, vol: 0.9, burst: 8 }] },
  { title: 'Network egress', unit: ' MB/s', max: 40, kind: 'line', digits: 1, series: [{ name: 'web', color: '#9466f8', mean: 12, vol: 2.2, burst: 16 }] },
];

const POINTS = 42;
const CHART_W = 250;
const CHART_H = 112;
const STEP = CHART_W / (POINTS - 2);
const TICK_MS = 1000;

function nextValue(prev: number, s: SeriesSpec, max: number, kind: ChartSpec['kind']): number {
  if (s.drift) return Math.min(max * 0.95, prev + s.drift * Math.random() + (Math.random() - 0.5) * s.vol);
  let v = prev + (s.mean - prev) * 0.18 + (Math.random() - 0.5) * 2 * s.vol;
  if (s.burst && Math.random() < 0.07) v += s.burst * (0.5 + Math.random() * 0.5);
  if (kind === 'bars') v = Math.random() < 0.72 ? 0 : Math.round(Math.max(0, v));
  return Math.max(0, Math.min(max * 0.96, v));
}

function seedSeries(s: SeriesSpec, max: number, kind: ChartSpec['kind']): number[] {
  const out: number[] = [];
  let v = s.drift ? s.mean - s.drift * POINTS * 0.5 : s.mean;
  for (let i = 0; i < POINTS; i++) out.push((v = nextValue(v, s, max, kind)));
  return out;
}

/** Catmull-Rom spline through the points, as cubic Bézier segments. */
function smoothPath(pts: [number, number][]): string {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * A streaming chart: a new sample arrives every second at the right edge and the whole trace glides left
 * continuously in between. Paths are written straight to the DOM each frame, so React never re-renders it.
 */
function LiveChart({ spec, active }: { spec: ChartSpec; active: boolean }) {
  const gid = useId().replace(/:/g, '');
  const data = useRef<number[][]>(spec.series.map((s) => seedSeries(s, spec.max, spec.kind)));
  const lines = useRef<(SVGPathElement | null)[]>([]);
  const areas = useRef<(SVGPathElement | null)[]>([]);
  const bars = useRef<(SVGRectElement | null)[]>([]);
  const readout = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const y = (v: number) => CHART_H - (v / spec.max) * (CHART_H - 6);
    const fmt = (v: number) => `${v.toFixed(spec.digits)}${spec.unit}`;
    let last = performance.now();
    let raf = 0;

    const draw = (t: number) => {
      const off = t * STEP;
      data.current.forEach((d, si) => {
        if (spec.kind === 'bars') {
          d.forEach((v, i) => {
            const r = bars.current[i];
            if (!r) return;
            const h = (v / spec.max) * (CHART_H - 6);
            r.setAttribute('x', (i * STEP - off - STEP * 0.32).toFixed(1));
            r.setAttribute('y', (CHART_H - h).toFixed(1));
            r.setAttribute('height', Math.max(0, h).toFixed(1));
          });
          return;
        }
        const pts = d.map((v, i) => [i * STEP - off, y(v)] as [number, number]);
        const line = smoothPath(pts);
        lines.current[si]?.setAttribute('d', line);
        areas.current[si]?.setAttribute('d', `${line} L${pts[pts.length - 1][0].toFixed(1)} ${CHART_H} L${pts[0][0].toFixed(1)} ${CHART_H} Z`);
      });
      const s0 = data.current[0];
      const shown = spec.kind === 'bars' ? s0[s0.length - 2] : s0[s0.length - 2] + (s0[s0.length - 1] - s0[s0.length - 2]) * t;
      if (readout.current) readout.current.textContent = fmt(shown);
    };

    draw(0);
    if (!active || reduceMotion()) return;
    const frame = (now: number) => {
      let t = (now - last) / TICK_MS;
      if (t >= 1) {
        // Shift every series by one sample and append a fresh one at the right edge.
        data.current = data.current.map((d, si) => [...d.slice(1), nextValue(d[d.length - 1], spec.series[si], spec.max, spec.kind)]);
        last = now;
        t = 0;
      }
      draw(t);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, spec]);

  const ticks = [0.25, 0.5, 0.75];
  return (
    <div className="st-obs-chart">
      <div className="st-chart-head">
        <span className="st-obs-title">{spec.title}</span>
        <span ref={readout} className="st-chart-value" />
      </div>
      <div className="st-chart-legend">
        {spec.series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
      </div>
      <div className="st-chart-plot">
        <svg width={CHART_W} height={CHART_H} className="st-spark" aria-hidden="true">
          <defs>
            {spec.series.map((s, i) => (
              <linearGradient key={s.name} id={`${gid}-g${i}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={i === 0 ? 0.28 : 0.12} />
                <stop offset="1" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((g) => <line key={g} x1="0" x2={CHART_W} y1={CHART_H - g * (CHART_H - 6)} y2={CHART_H - g * (CHART_H - 6)} />)}
          {spec.kind === 'bars'
            ? Array.from({ length: POINTS }, (_, i) => (
                <rect key={i} ref={(el) => { bars.current[i] = el; }} width={STEP * 0.64} rx="1" fill={spec.series[0].color} />
              ))
            : spec.series.map((s, i) => (
                <g key={s.name}>
                  <path ref={(el) => { areas.current[i] = el; }} fill={`url(#${gid}-g${i})`} stroke="none" />
                  <path ref={(el) => { lines.current[i] = el; }} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" />
                </g>
              ))}
        </svg>
        {/* Value labels live in their own gutter, each level with its gridline, so traces never run through them. */}
        <div className="st-chart-y" aria-hidden="true" style={{ height: CHART_H }}>
          {ticks.map((g) => (
            <span key={g} style={{ top: CHART_H - g * (CHART_H - 6) - 6 }}>{(spec.max * g).toFixed(spec.max < 10 ? 1 : 0)}</span>
          ))}
        </div>
      </div>
      <div className="st-chart-x" aria-hidden="true"><span>-40s</span><span>-20s</span><span>now</span></div>
    </div>
  );
}

function ObserveMock() {
  const [ref, active] = useActive<HTMLDivElement>();
  const [t, setT] = useState(0);
  useTick(() => setT((v) => v + 1), 1800, active);
  const rows = Array.from({ length: 4 }, (_, i) => {
    const k = t - i;
    const [svc, msg] = LOG_POOL[((k % LOG_POOL.length) + LOG_POOL.length) % LOG_POOL.length];
    const sec = ((k * 7) % 60 + 60) % 60;
    return { key: k, time: `Nov 01 14:${String(32 + Math.floor(((k % 20) + 20) % 20 / 2)).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, svc, msg };
  });
  return (
    <div ref={ref}>
      <Scaled w={1000} className="st-mock">
        <Chrome project="storefront" tab="Observability">
          <div className="st-obs">
            <div className="st-obs-bar"><span className="st-chip"><AlarmClock /> Last 7 days <ChevronDown /></span><span className="st-live"><i /> Live</span></div>
            <div className="st-obs-logs">
              <div className="st-obs-title">Error logs</div>
              <div className="st-obs-head"><span>Time (UTC)</span><span>Service</span><span>Message</span></div>
              {rows.map((r, i) => (
                <div key={r.key} className={`st-obs-row${i === 0 && t > 0 ? ' fresh' : ''}`}><span>{r.time}</span><span>{r.svc}</span><span>{r.msg}</span></div>
              ))}
            </div>
            <div className="st-obs-grid">
              {CHARTS.map((c) => <LiveChart key={c.title} spec={c} active={active} />)}
            </div>
          </div>
        </Chrome>
      </Scaled>
    </div>
  );
}

/* ----------------------------------------------- 5. environments ----------------------------------------------- */

type EnvNodeId = 'frontend' | 'backend' | 'api' | 'postgres' | 'workers' | 'cron';

/** Service cards inside an environment pane (pane body coordinates, px at design size). */
const ENV_NODES: Record<EnvNodeId, { x: number; y: number; name: string; badge: Badge; sub: string; rows?: string[] }> = {
  frontend: { x: 22, y: 64, name: 'frontend', badge: B.js, sub: 'Deployed just now' },
  backend: { x: 168, y: 64, name: 'backend', badge: { t: 'Bn', c: '#4ade80' }, sub: 'Deployed just now' },
  api: { x: 168, y: 64, name: 'api', badge: B.go, sub: 'Deployed just now' },
  postgres: { x: 314, y: 64, name: 'postgres', badge: B.pg, sub: 'pg-data' },
  workers: { x: 168, y: 158, name: 'workers', badge: B.py, sub: '2 instances', rows: ['worker 1', 'worker 2'] },
  cron: { x: 22, y: 158, name: 'cron', badge: { t: 'Cr', c: '#fdba74' }, sub: 'Next run in 2h' },
};
const ENV_NODE_IDS = Object.keys(ENV_NODES) as EnvNodeId[];
const CARD_W = 122;

/** Each preview environment introduces one change, which then gets promoted to production. */
const ENV_STEPS: { name: string; c: string; nodes: EnvNodeId[]; change: EnvNodeId[] }[] = [
  { name: 'staging', c: '#9466f8', nodes: ['frontend', 'backend'], change: ['backend'] },
  { name: 'development', c: '#22c55e', nodes: ['frontend', 'backend', 'postgres'], change: ['postgres'] },
  { name: 'pr-112', c: '#f59e0b', nodes: ['frontend', 'api', 'postgres', 'workers'], change: ['api', 'workers'] },
  { name: 'pr-115', c: '#a1a1aa', nodes: ['frontend', 'api', 'postgres', 'workers', 'cron'], change: ['cron'] },
];

interface EnvFrame { front: number; envHot: boolean; prod: EnvNodeId[]; prodHot: EnvNodeId[]; rollback: boolean }

/** The loop: for each environment show its change, promote it to production, let it settle; then roll production back. */
const ENV_FRAMES: EnvFrame[] = (() => {
  const frames: EnvFrame[] = [];
  let prod: EnvNodeId[] = ['frontend'];
  ENV_STEPS.forEach((step, i) => {
    frames.push({ front: i, envHot: true, prod, prodHot: [], rollback: false });
    prod = step.nodes;
    frames.push({ front: i, envHot: true, prod, prodHot: step.change, rollback: false });
    frames.push({ front: i, envHot: false, prod, prodHot: [], rollback: false });
  });
  const last = ENV_STEPS.length - 1;
  frames.push({ front: last, envHot: false, prod, prodHot: [], rollback: true });
  frames.push({ front: last, envHot: false, prod: ['frontend'], prodHot: [], rollback: true });
  frames.push({ front: last, envHot: false, prod: ['frontend'], prodHot: [], rollback: false });
  return frames;
})();

function envEdges(present: Set<EnvNodeId>): string[] {
  const at = (id: EnvNodeId) => ENV_NODES[id];
  const paths: string[] = [];
  const service: EnvNodeId | null = present.has('api') ? 'api' : present.has('backend') ? 'backend' : null;
  const h = (a: EnvNodeId, b: EnvNodeId) => `M${at(a).x + CARD_W} ${at(a).y + 26} H${at(b).x}`;
  if (service && present.has('frontend')) paths.push(h('frontend', service));
  if (service && present.has('postgres')) paths.push(h(service, 'postgres'));
  if (present.has('api') && present.has('workers')) paths.push(`M${at('api').x + CARD_W / 2} ${at('api').y + 58} V${at('workers').y}`);
  if (present.has('cron') && present.has('workers')) paths.push(h('cron', 'workers'));
  return paths;
}

function EnvCanvas({ nodes, hot, accent }: { nodes: EnvNodeId[]; hot: EnvNodeId[]; accent?: string }) {
  const present = new Set(nodes);
  return (
    <div className="st-envcanvas">
      <svg className="st-envedges" width="460" height="290" aria-hidden="true">
        {envEdges(present).map((d) => <path key={d} d={d} />)}
      </svg>
      {ENV_NODE_IDS.map((id) => {
        const n = ENV_NODES[id];
        return (
          <div
            key={id}
            className={`st-envnode${present.has(id) ? ' in' : ''}${hot.includes(id) ? ' hot' : ''}`}
            style={{ left: n.x, top: n.y, width: CARD_W, '--accent': accent } as CSSProperties}
          >
            <div className="st-envnode-name"><BadgeTile b={n.badge} />{n.name}</div>
            {n.rows ? (
              n.rows.map((r) => <div key={r} className="st-envnode-row"><Check className="st-ok" />{r}</div>)
            ) : (
              <div className="st-envnode-sub"><Check className="st-ok" />{n.sub}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EnvMock() {
  const [ref, active] = useActive<HTMLDivElement>();
  const [k, setK] = useState(reduceMotion() ? 8 : 0);
  useTick(() => setK((v) => (v + 1) % ENV_FRAMES.length), 1300, active);
  const f = ENV_FRAMES[k];
  const step = ENV_STEPS[f.front];
  return (
    <div ref={ref}>
      <Scaled w={1000} h={440} className="st-mock">
        <div className="st-panel st-panel-env">
          <div className="st-envpane st-prod">
            <div className="st-envhead"><LayoutGrid /> production</div>
            <div className="st-envbody">
              <EnvCanvas nodes={f.prod} hot={f.prodHot} />
              <span className={`st-rollback${f.rollback ? ' on' : ''}`} aria-hidden="true"><RotateCcw /></span>
            </div>
          </div>
          <div className="st-deck">
            {ENV_STEPS.map((e, i) => {
              const depth = (i - f.front + ENV_STEPS.length) % ENV_STEPS.length;
              return (
                <div
                  key={e.name}
                  className="st-envpane st-deckpane"
                  style={{ '--c': e.c, '--depth': depth, zIndex: 10 - depth } as CSSProperties}
                  aria-hidden={depth !== 0}
                >
                  <div className="st-envhead"><GitPullRequest /> {e.name}<span className="st-envdot" /></div>
                  <div className="st-envbody">
                    {depth === 0 && (
                      <div key={step.name} className="st-envswap">
                        <EnvCanvas nodes={step.nodes} hot={f.envHot ? step.change : []} accent={e.c} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Scaled>
    </div>
  );
}

/* ------------------------------------------------ chapters + rail ------------------------------------------------ */

interface Feature { icon: ReactNode; title: string; body: string }
interface Chapter {
  id: string;
  pill: string;
  accent: string;
  title: [string, string];
  body: string;
  href: string;
  layout: 'stack' | 'split';
  band?: string;
  mock: ReactNode;
  features: Feature[];
  chips: string[];
}

const CHAPTERS: Chapter[] = [
  {
    id: 'build',
    pill: 'Build and deploy',
    accent: '#9466f8',
    band: 'panel',
    title: ['Push code.', 'Get a running service.'],
    body: 'Point NAV at a repository and it works out the runtime, builds an image and health-checks it before any traffic moves.',
    href: '/docs#deploys',
    layout: 'stack',
    mock: <CanvasMock />,
    features: [
      { icon: <Eye />, title: 'See the whole stack', body: 'Every service, database and connection on one canvas.' },
      { icon: <Sparkles />, title: 'Configured from your repo', body: 'Runtimes, build and start commands are detected for you.' },
      { icon: <Pencil />, title: 'Change it where you see it', body: 'Edit settings in the dashboard, or keep them in nav.yaml.' },
    ],
    chips: ['Node.js', 'Python', 'Go', 'Bun', 'Dockerfile'],
  },
  {
    id: 'network',
    pill: 'Connect privately',
    accent: '#9466f8',
    title: ['Private networking', 'that is already on.'],
    body: 'Services reach each other by internal host and port the moment they deploy. Nothing to configure and nothing exposed by default.',
    href: '/docs#private-network',
    layout: 'split',
    mock: <NetworkMock />,
    features: [
      { icon: <Shield />, title: 'Internal by default', body: 'Workers and private services get no public route unless you add one.' },
      { icon: <Network />, title: 'Balanced across instances', body: 'Connections spread over every healthy instance automatically.' },
    ],
    chips: ['TCP', 'HTTP', 'WebSockets', 'TLS via ACME'],
  },
  {
    id: 'scale',
    pill: 'Scale with load',
    accent: '#9466f8',
    title: ['From one instance to many,', 'without a rewrite.'],
    body: 'Pick a bigger plan, or let autoscaling add instances when CPU and memory run hot. The load balancer keeps up on its own.',
    href: '/docs#scaling',
    layout: 'split',
    mock: <ScaleMock />,
    features: [
      { icon: <Zap />, title: 'Bigger when you need it', body: 'Move between plans without touching your code.' },
      { icon: <Copy />, title: 'More when traffic spikes', body: 'Instances are added and removed between the limits you set.' },
    ],
    chips: ['Plans', 'Autoscaling', 'Persistent disks'],
  },
  {
    id: 'observe',
    pill: 'Monitor and observe',
    accent: '#9466f8',
    band: 'panel',
    title: ['Logs and metrics in one place,', 'from the very first deploy.'],
    body: 'Build output, runtime logs and CPU, memory and request charts stream live for every service you run.',
    href: '/docs#logs-and-metrics',
    layout: 'stack',
    mock: <ObserveMock />,
    features: [
      { icon: <ScrollText />, title: 'Live log tails', body: 'Follow every instance in the dashboard or with nav logs.' },
      { icon: <Bell />, title: 'Events you can trace', body: 'Every deploy, restart and scale change lands in the activity feed.' },
      { icon: <Eye />, title: 'Metrics per service', body: 'CPU, memory, disk and requests, sampled continuously.' },
    ],
    chips: ['Build logs', 'Runtime logs', 'Metrics', 'Activity'],
  },
  {
    id: 'collab',
    pill: 'Preview and collaborate',
    accent: '#9466f8',
    title: ['Every pull request', 'gets its own environment.'],
    body: 'Previews spin up from your branch with their own URL and settings, and one click rolls back anything that slips through.',
    href: '/docs#preview-environments',
    layout: 'stack',
    mock: <EnvMock />,
    features: [
      { icon: <Users />, title: 'Everyone ships in parallel', body: 'Each branch runs on its own, so nobody waits on staging.' },
      { icon: <Globe />, title: 'Review the real thing', body: 'Reviewers open a link instead of pulling a branch.' },
      { icon: <RotateCcw />, title: 'Undo in seconds', body: 'Roll back to any earlier deploy instantly.' },
    ],
    chips: ['Preview environments', 'Rollbacks', 'Deploy hooks'],
  },
];

function ChapterText({ c }: { c: Chapter }) {
  return (
    <div className="st-copy k-rv">
      <span className="st-pill-label">{c.pill}</span>
      <h3 className="st-h">{c.title[0]}<br />{c.title[1]}</h3>
      <p className="st-p">{c.body} <Link to={c.href} className="st-more">Learn more <ArrowRight /></Link></p>
    </div>
  );
}

function Chips({ c }: { c: Chapter }) {
  return (
    <div className="st-chips k-rv">
      <span className="st-chips-label"><Sparkles /> Works with</span>
      {c.chips.map((x) => <span key={x} className="st-chip-tag">{x}</span>)}
    </div>
  );
}

export function Story() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);

  // Rail thumb: follows the viewport centre and takes the colour of the chapter there.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const y = Math.max(0, Math.min(r.height - 104, vh * 0.5 - r.top - 52));
      el.style.setProperty('--thumb', `${y.toFixed(1)}px`);
      const chapters = [...el.querySelectorAll<HTMLElement>('.st-ch')];
      let idx = 0;
      chapters.forEach((ch, i) => { if (ch.getBoundingClientRect().top <= vh * 0.5) idx = i; });
      setActive(idx);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <section ref={ref} id="platform" className="st" aria-label="What NAV does" style={{ '--st-acc': CHAPTERS[active].accent } as CSSProperties}>
      <div className="st-thumb" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
      {CHAPTERS.map((c, i) => (
        <article key={c.id} id={`story-${c.id}`} className={`st-ch st-is-${c.layout}${c.band ? ' st-band' : ''}`} style={{ '--acc': c.accent, '--band': c.band } as CSSProperties}>
          <span className={`st-node-dot${active === i ? ' on' : ''}`} aria-hidden="true" />
          {c.layout === 'stack' ? (
            <>
              <ChapterText c={c} />
              <div className="st-visual k-rv">{c.mock}</div>
              <div className="st-feats">
                {c.features.map((f) => (
                  <div key={f.title} className="st-feat k-rv"><span>{f.icon}</span><h4>{f.title}</h4><p>{f.body}</p></div>
                ))}
              </div>
            </>
          ) : (
            <div className="st-split">
              <div>
                <ChapterText c={c} />
                <ul className="st-list">
                  {c.features.map((f) => (
                    <li key={f.title} className="k-rv"><span>{f.icon}</span><div><h4>{f.title}</h4><p>{f.body}</p></div></li>
                  ))}
                </ul>
                <Chips c={c} />
              </div>
              <div className="st-visual k-rv">{c.mock}</div>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
