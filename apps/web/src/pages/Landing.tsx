import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes, Clock, Cpu, Database, FileCode2, Globe, HardDrive, KeyRound, Layers,
  Lock, Network, Radio, ScrollText, Shield, ShieldCheck, Terminal, Users, Webhook, Zap,
} from 'lucide-react';
import { DATABASE_PLANS, SERVICE_PLANS, type Plan } from '@nav/shared';
import { useMe } from '@/api/auth';
import { LogoMark } from '@/components/Logo';
import { formatMemory } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import './landing.css';

/* Background loop + its own first frame as poster (supplied with the design brief). */
const ART_VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260912_104303_0c6d60b2-9353-408e-9449-585108a22fb5.mp4';
const ART_POSTER = 'https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/130837c4-0244-4f37-9c61-8d801d93fd29.jpg';

const doc = (slug: string) => `/docs#${slug}`;
type Icon = typeof Globe;

// ---- Navigation data ---------------------------------------------------------------------------
const PRODUCT_SERVICES: { icon: Icon; title: string; body: string; slug: string }[] = [
  { icon: Globe, title: 'Web Services', body: 'Public HTTP apps with TLS and zero-downtime deploys', slug: 'web-services' },
  { icon: Network, title: 'Private Services', body: 'Internal APIs reachable only on the private network', slug: 'private-services' },
  { icon: Cpu, title: 'Background Workers', body: 'Long-running processes that consume queues', slug: 'background-workers' },
  { icon: Clock, title: 'Cron Jobs', body: 'Scheduled commands with full run history', slug: 'cron-jobs' },
  { icon: Layers, title: 'Static Sites', body: 'Built once, served from the edge with caching', slug: 'static-sites' },
  { icon: Database, title: 'NAV Postgres', body: 'Managed PostgreSQL with backups and restore', slug: 'postgres' },
];
const PRODUCT_FEATURES: [string, string][] = [
  ['Preview Environments', 'preview-environments'],
  ['Infrastructure as Code', 'infrastructure-as-code'],
  ['Zero-Downtime Deploys', 'deploys'],
  ['Autoscaling', 'scaling'],
  ['Private Networking', 'private-network'],
  ['Persistent Disks', 'persistent-disks'],
  ['NAV CLI', 'cli'],
  ['REST API', 'rest-api'],
];
const SOLUTIONS: { title: string; links: [string, string][] }[] = [
  { title: 'Use cases', links: [['SaaS backends', 'web-services'], ['AI agents & workers', 'background-workers'], ['Internal tools', 'private-services'], ['Scheduled data jobs', 'cron-jobs']] },
  { title: 'By team', links: [['Startups', 'getting-started'], ['Platform teams', 'self-hosting'], ['Security-minded teams', 'security']] },
  { title: 'Migrate', links: [['Move a Dockerfile app', 'docker'], ['Bring a nav.yaml', 'infrastructure-as-code'], ['Self-hosting guide', 'self-hosting']] },
];
const RESOURCES: [string, string][] = [
  ['Documentation', 'getting-started'],
  ['Framework quickstarts', 'quickstarts'],
  ['Changelog', 'changelog'],
  ['CLI reference', 'cli'],
  ['REST API', 'rest-api'],
  ['FAQ', 'faq'],
];

const STACK = [
  ['JS', 'Node.js'], ['Py', 'Python'], ['Go', 'Go'], ['Rb', 'Ruby'], ['Bn', 'Bun'], ['🐳', 'Docker'], ['N', 'Next.js'], ['Dj', 'Django'],
  ['Fa', 'FastAPI'], ['Ex', 'Express'], ['Ra', 'Rails'], ['Fl', 'Flask'], ['Vi', 'Vite'], ['As', 'Astro'], ['PG', 'Postgres'], ['Gn', 'Gin'],
] as const;

const BUILDER_TILES: { icon: Icon; title: string; body: string; soon?: boolean }[] = [
  { icon: Terminal, title: 'Native language runtimes', body: 'Node, Bun, Python, Go and Ruby detected and built without a Dockerfile.' },
  { icon: FileCode2, title: 'Infrastructure as code', body: 'Describe services, databases and env groups in one versioned nav.yaml.' },
  { icon: Boxes, title: 'Isolated environments', body: 'Projects and environments keep staging and production apart.' },
  { icon: HardDrive, title: 'Persistent disks', body: 'Attach durable storage to a service that survives every deploy.' },
  { icon: KeyRound, title: 'Env groups & secret files', body: 'Share configuration across services; encrypted at rest.' },
  { icon: Radio, title: 'WebSockets', body: 'Long-lived, bidirectional connections pass straight through the edge.' },
  { icon: Zap, title: 'Edge caching for static sites', body: 'ETags, immutable asset caching and compression out of the box.' },
  { icon: Lock, title: 'Fully-managed TLS', body: 'Certificates issue and renew automatically for every custom domain.' },
];

const SECURITY_TILES: { icon: Icon; title: string; body: string }[] = [
  { icon: Network, title: 'Private networking', body: 'Service-to-service traffic stays on an internal network, never the internet.' },
  { icon: Shield, title: 'Container isolation', body: 'Per-plan CPU and memory limits, dropped capabilities, no-new-privileges.' },
  { icon: Users, title: 'Role-based access', body: 'Owner, admin, developer and viewer roles on every workspace.' },
  { icon: ScrollText, title: 'Activity log', body: 'Every deploy, scale, env change and domain event is recorded.' },
  { icon: ShieldCheck, title: 'Encryption at rest', body: 'AES-256-GCM for env vars, secret files, database passwords and TLS keys.' },
  { icon: Webhook, title: 'Signed webhooks', body: 'GitHub deliveries verified with HMAC-SHA256; deploy hooks use random keys.' },
];

// ---- Small visuals ---------------------------------------------------------------------------------
function Spark({ seed, color = '#a8ccfc' }: { seed: number; color?: string }) {
  const pts = Array.from({ length: 24 }, (_, i) => {
    const y = 15 + Math.sin(i * 0.7 + seed) * 6 + Math.sin(i * 1.9 + seed * 2) * 4;
    return `${(i / 23) * 100},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Chev() {
  return (
    <svg className="nv-chev" viewBox="0 0 11 20" aria-hidden="true">
      <path d="M1.15 1.15 L9.6 10 L1.15 18.85" />
    </svg>
  );
}

function Caret() {
  return (
    <svg className="nl-caret" viewBox="0 0 9 6" aria-hidden="true">
      <path d="M0.7 1.1 L4.5 4.6 L8.3 1.1" />
    </svg>
  );
}

function ServiceCard({ name, icon: I, metrics }: { name: string; icon: Icon; metrics: [string, string][] }) {
  return (
    <div className="nl-svc">
      <div className="nl-svc-top">
        <span>
          <I strokeWidth={1.6} /> {name}
        </span>
        <span className="nl-avail">✓ Available</span>
      </div>
      <div className="nl-sparks">
        {metrics.map(([label, color], i) => (
          <div key={label} className="nl-spark">
            <small>{label}</small>
            <Spark seed={name.length + i * 3} color={color} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanTable({ title, unit, plans }: { title: string; unit: string; plans: Plan[] }) {
  return (
    <div className="nl-plan nv-panel">
      <header>
        <h3>{title}</h3>
        <p>{unit}</p>
      </header>
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>CPU</th>
            <th>Memory</th>
            <th style={{ textAlign: 'right' }}>Price</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td className="mono">{p.cpu} vCPU</td>
              <td className="mono">{formatMemory(p.memoryMB)}</td>
              <td className="price">
                <b style={{ fontWeight: 581 }}>${p.priceMonthly}</b>
                <span style={{ color: '#6b7488' }}>/mo</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ title, body, link, slug, art }: { title: string; body: string; link: string; slug: string; art: ReactNode }) {
  return (
    <article className="nl-row nv-panel">
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
        <Link to={doc(slug)} className="nl-doclink">
          {link}
        </Link>
      </div>
      <div className="nl-row-art" aria-hidden="true">
        {art}
      </div>
    </article>
  );
}

// ---- Page ------------------------------------------------------------------------------------------
type MenuId = 'product' | 'solutions' | 'resources' | null;

export function LandingPage() {
  useTitle(null);
  const me = useMe();
  const signedIn = !!me.data;
  const start = signedIn ? '/app' : '/signup';
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const footRef = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<MenuId>(null);
  const [stuck, setStuck] = useState(false);
  const [status, setStatus] = useState<'checking' | 'up' | 'down'>('checking');

  // Reduced motion pauses the background video (the CSS reset cannot reach media playback).
  useEffect(() => {
    const v = videoRef.current;
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!v) return;
    const sync = () => (q.matches ? v.pause() : void v.play()?.catch(() => {}));
    sync();
    q.addEventListener('change', sync);
    return () => q.removeEventListener('change', sync);
  }, []);

  // Retire the entrance once the last tween ends, so later breakpoint changes never replay it.
  useEffect(() => {
    const root = rootRef.current;
    const last = footRef.current;
    if (!root || !last) return;
    const done = () => {
      clearTimeout(timer);
      last.removeEventListener('animationend', done);
      root.classList.add('is-entered');
    };
    const timer = setTimeout(done, 4000);
    last.addEventListener('animationend', done);
    return () => {
      clearTimeout(timer);
      last.removeEventListener('animationend', done);
    };
  }, []);

  // Glass bar once the page scrolls past the hero top.
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Mega menus: Escape and outside clicks close them.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    const onDown = (e: MouseEvent) => !barRef.current?.contains(e.target as Node) && setMenu(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menu]);

  // Real platform status for the footer.
  useEffect(() => {
    fetch('/api/v1/config', { cache: 'no-store' })
      .then((r) => setStatus(r.ok ? 'up' : 'down'))
      .catch(() => setStatus('down'));
  }, []);

  const toggle = (id: Exclude<MenuId, null>) => setMenu((m) => (m === id ? null : id));
  const menuButton = (id: Exclude<MenuId, null>, label: string) => (
    <button type="button" aria-expanded={menu === id} aria-controls={`mega-${id}`} onClick={() => toggle(id)}>
      {label}
      <Caret />
    </button>
  );

  return (
    <div ref={rootRef} className="nl" data-theme="dark" onMouseLeave={() => setMenu(null)}>
      <div className="nl-announce">
        <span>NAV is open infrastructure — run the whole platform on your own servers.</span>
        <Link to={doc('self-hosting')}>Self-hosting guide</Link>
      </div>

      <header ref={barRef} className={`nl-bar${stuck ? ' is-stuck' : ''}`}>
        <a className="nl-brand" href="#top" aria-label="NAV home">
          <LogoMark />
          <span aria-hidden>NAV</span>
        </a>

        <ul className="nl-menu">
          <li>{menuButton('product', 'Product')}</li>
          <li>{menuButton('solutions', 'Solutions')}</li>
          <li>{menuButton('resources', 'Resources')}</li>
          <li>
            <Link to="/docs">Docs</Link>
          </li>
          <li>
            <a href="#pricing">Pricing</a>
          </li>
        </ul>

        <div className="nl-right">
          <Link className="nl-login" to={signedIn ? '/app' : '/login'}>
            {signedIn ? 'Open dashboard' : 'Log in / Sign up'}
            <svg className="nl-navarrow" viewBox="0 0 10 9" aria-hidden="true">
              <path d="M0 4.5 H9.1 M5.4 0.9 L9.2 4.5 L5.4 8.1" />
            </svg>
          </Link>
          <Link className="nl-pill" to={start}>
            {signedIn ? 'Dashboard' : 'Start for free'}
          </Link>

          {/* Below the desktop composition: pure-CSS checkbox menu, no JS. */}
          <input className="nl-navtoggle" type="checkbox" id="nl-nav-open" aria-label="Toggle menu" />
          <label className="nl-scrim" htmlFor="nl-nav-open" aria-hidden="true" />
          <label className="nl-burger" htmlFor="nl-nav-open" aria-label="Menu">
            <svg viewBox="0 0 22 14" aria-hidden="true">
              <path className="b1" d="M1 1 H21" />
              <path className="b2" d="M1 7 H21" />
              <path className="b3" d="M1 13 H21" />
            </svg>
          </label>
          <nav className="nl-mobile" aria-label="Mobile">
            <details>
              <summary>
                Product <Caret />
              </summary>
              {PRODUCT_SERVICES.map((s) => (
                <Link key={s.slug} to={doc(s.slug)}>
                  {s.title}
                </Link>
              ))}
              {PRODUCT_FEATURES.map(([t, s]) => (
                <Link key={t} to={doc(s)}>
                  {t}
                </Link>
              ))}
            </details>
            <details>
              <summary>
                Solutions <Caret />
              </summary>
              {SOLUTIONS.flatMap((g) => g.links).map(([t, s]) => (
                <Link key={t} to={doc(s)}>
                  {t}
                </Link>
              ))}
            </details>
            <details>
              <summary>
                Resources <Caret />
              </summary>
              {RESOURCES.map(([t, s]) => (
                <Link key={t} to={doc(s)}>
                  {t}
                </Link>
              ))}
            </details>
            <Link to="/docs">Docs</Link>
            <a href="#pricing">Pricing</a>
            <Link to={signedIn ? '/app' : '/login'}>{signedIn ? 'Open dashboard' : 'Log in / Sign up'}</Link>
            <Link className="nl-pill" to={start}>
              {signedIn ? 'Dashboard' : 'Start for free'}
            </Link>
          </nav>
        </div>

        {menu === 'product' && (
          <div id="mega-product" className="nl-mega" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
            <div>
              <h4>Services</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 24 }}>
                {PRODUCT_SERVICES.map((s) => (
                  <Link key={s.slug} to={doc(s.slug)} className="nl-mega-item" onClick={() => setMenu(null)}>
                    <s.icon strokeWidth={1.6} />
                    <span>
                      <b>{s.title}</b>
                      <small>{s.body}</small>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <h4>Features</h4>
              {PRODUCT_FEATURES.map(([t, s]) => (
                <Link key={t} to={doc(s)} className="nl-mega-link" onClick={() => setMenu(null)}>
                  {t}
                </Link>
              ))}
            </div>
          </div>
        )}
        {menu === 'solutions' && (
          <div id="mega-solutions" className="nl-mega" style={{ gridTemplateColumns: '1fr 1fr 1.3fr 1fr' }}>
            {SOLUTIONS.slice(0, 2).map((g) => (
              <div key={g.title}>
                <h4>{g.title}</h4>
                {g.links.map(([t, s]) => (
                  <Link key={t} to={doc(s)} className="nl-mega-link" onClick={() => setMenu(null)}>
                    {t}
                  </Link>
                ))}
              </div>
            ))}
            <div>
              <h4>Architecture</h4>
              <Link to={doc('getting-started')} className="nl-mega-card" onClick={() => setMenu(null)}>
                <div className="nl-mega-card-art" />
                <div style={{ padding: '12px 14px' }}>
                  <b style={{ fontWeight: 506, fontSize: 13.5 }}>How a git push becomes a live service</b>
                  <small style={{ display: 'block', color: '#a2a9b8', marginTop: 4 }}>Builds, health checks and the edge, end to end →</small>
                </div>
              </Link>
            </div>
            <div>
              <h4>{SOLUTIONS[2].title}</h4>
              {SOLUTIONS[2].links.map(([t, s]) => (
                <Link key={t} to={doc(s)} className="nl-mega-link" onClick={() => setMenu(null)}>
                  {t}
                </Link>
              ))}
            </div>
          </div>
        )}
        {menu === 'resources' && (
          <div id="mega-resources" className="nl-mega" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <div>
              <h4>Learn</h4>
              {RESOURCES.slice(0, 3).map(([t, s]) => (
                <Link key={t} to={doc(s)} className="nl-mega-link" onClick={() => setMenu(null)}>
                  {t}
                </Link>
              ))}
            </div>
            <div>
              <h4>Build</h4>
              {RESOURCES.slice(3).map(([t, s]) => (
                <Link key={t} to={doc(s)} className="nl-mega-link" onClick={() => setMenu(null)}>
                  {t}
                </Link>
              ))}
            </div>
            <div>
              <h4>Account</h4>
              <Link to={start} className="nl-mega-link" onClick={() => setMenu(null)}>
                {signedIn ? 'Dashboard' : 'Create an account'}
              </Link>
              <a href="#pricing" className="nl-mega-link" onClick={() => setMenu(null)}>
                Pricing
              </a>
              <Link to={doc('security')} className="nl-mega-link" onClick={() => setMenu(null)}>
                Security
              </Link>
            </div>
          </div>
        )}
      </header>

      {/* ---- Hero ---- */}
      <section className="nl-hero" id="top">
        <video ref={videoRef} className="nl-art" autoPlay muted loop playsInline preload="auto" aria-hidden="true" poster={ART_POSTER} src={ART_VIDEO} />
        <div className="nl-veil" />
        <main className="nl-stage">
          <h1 className="nl-title">
            <span>Your Fastest Path to Production,</span>{' '}
            <span>on Infrastructure You Own.</span>
          </h1>
          <p className="nl-sub">
            <span>Deploy web services, workers, cron jobs and Postgres</span>{' '}
            <span>from a git push — NAV runs the rest.</span>
          </p>
          <Link className="nl-cta nv-btn nv-cta" to={start}>
            <span>{signedIn ? 'Open your dashboard' : 'Start for free'}</span>
            <svg className="nl-arrow" viewBox="0 0 16 11" aria-hidden="true">
              <path d="M0 5.5 H14.6 M10.3 1.2 L14.9 5.5 L10.3 9.8" />
            </svg>
          </Link>
          <ul className="nl-feats">
            {['Git push deploys', 'Zero-downtime releases', 'Managed Postgres', 'Self-hostable'].map((f) => (
              <li key={f}>
                <Chev />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <span className="nl-rule nv-rule" aria-hidden="true" />
        </main>
        <footer className="nl-foot">
          <span>Open infrastructure for teams who would rather ship than babysit servers.</span>
          <span ref={footRef}>v0.1</span>
        </footer>
      </section>

      {/* ---- Production at a glance ---- */}
      <section className="nl-section" id="platform">
        <div className="nl-inner nl-prod">
          <div>
            <span className="nl-kicker">Production</span>
            <h2 className="nl-h2">Push once. Watch it go live.</h2>
            <p className="nl-lede">Every service gets health-checked instances, live metrics and a public URL the moment its first deploy passes.</p>
            <span className="nl-gitchip">$ git push</span>
          </div>
          <div className="nl-board nv-panel">
            <div className="nl-board-head">
              <span>Production</span>
              <span style={{ color: '#5fe0a3' }}>● all healthy</span>
            </div>
            <div className="nl-svcs">
              <ServiceCard name="app-backend" icon={Globe} metrics={[['Memory', '#a8ccfc'], ['CPU', '#ffe2b2']]} />
              <ServiceCard name="app-worker" icon={Cpu} metrics={[['Memory', '#a8ccfc'], ['Jobs', '#ffe2b2']]} />
              <ServiceCard name="app-database" icon={Database} metrics={[['Memory', '#a8ccfc'], ['Connections', '#ffe2b2']]} />
              <ServiceCard name="app-frontend" icon={Layers} metrics={[['Requests', '#a8ccfc'], ['Bandwidth', '#ffe2b2']]} />
            </div>
          </div>
        </div>
      </section>

      {/* ---- Whatever your stack ---- */}
      <section className="nl-stack" aria-labelledby="stack-h">
        <div>
          <h2 id="stack-h" className="nl-h2" style={{ marginTop: 0, fontSize: 'clamp(28px, 3vw, 40px)' }}>
            Whatever your stack, it runs on NAV.
          </h2>
          <Link to={doc('quickstarts')} className="nv-btn nv-hair" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 42, padding: '0 20px', marginTop: 24, fontSize: 13.5 }}>
            View quickstarts →
          </Link>
        </div>
        <div className="nl-marquee" aria-label="Supported runtimes and frameworks">
          {[0, 1].map((row) => (
            <div key={row} className={`nl-track${row ? ' rev' : ''}`}>
              {[...STACK.slice(row * 8, row * 8 + 8), ...STACK.slice(row * 8, row * 8 + 8)].map(([g, name], i) => (
                <span key={`${name}-${i}`} className="nl-tile" aria-hidden={i >= 8}>
                  <span>
                    <b>{g}</b>
                    {name}
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* ---- Click, click, done ---- */}
      <section className="nl-section" id="how">
        <div className="nl-inner">
          <span className="nl-kicker">How it works</span>
          <h2 className="nl-h2">Click, click, done.</h2>
          <div className="nl-steps">
            <div className="nl-step nv-panel">
              <span className="nl-step-n">1</span>
              <h3>Pick a service</h3>
              <p>Web service, private service, worker, cron job, static site or Postgres — whatever your app needs.</p>
              <div className="nl-step-art" aria-hidden="true">
                {['Web Service', 'Background Worker', 'Cron Job', 'Static Site', 'Postgres'].map((s, i) => (
                  <div key={s} className={`nl-choice${i === 0 ? ' on' : ''}`}>
                    <span>{s}</span>
                    {i === 0 && <span style={{ color: '#5fe0a3' }}>✓</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="nl-step nv-panel">
              <span className="nl-step-n">2</span>
              <h3>Deploy your code</h3>
              <p>Connect a repo. NAV detects the runtime, builds it and gates the release on health checks.</p>
              <div className="nl-step-art nl-log" aria-hidden="true">
                <span className="cm">==&gt; Cloning repository@main</span>
                {'\n'}
                <span className="hl">==&gt; Detected runtime: node</span>
                {'\n'}==&gt; npm ci &amp;&amp; npm run build{'\n'}    build-info.json written{'\n'}
                <span className="cm">==&gt; Starting 2 instances</span>
                {'\n'}
                <span className="ok">==&gt; Your service is live ✓</span>
              </div>
            </div>
            <div className="nl-step nv-panel">
              <span className="nl-step-n">3</span>
              <h3>NAV does the rest</h3>
              <p>Networking, TLS, scaling, previews, rollbacks and monitoring — ready from the first deploy.</p>
              <div className="nl-step-art" aria-hidden="true">
                <svg viewBox="0 0 260 170" style={{ width: '100%', height: '100%' }}>
                  <defs>
                    <linearGradient id="nl-wire" x1="0" x2="1">
                      <stop stopColor="#ffe2b2" />
                      <stop offset="1" stopColor="#a8ccfc" />
                    </linearGradient>
                  </defs>
                  {[
                    [130, 18, 'edge'],
                    [60, 85, 'web'],
                    [200, 85, 'api'],
                    [60, 150, 'worker'],
                    [200, 150, 'postgres'],
                  ].map(([x, y, label]) => (
                    <g key={label as string}>
                      <rect x={(x as number) - 34} y={(y as number) - 13} width="68" height="26" rx="13" fill="rgba(255,255,255,0.05)" stroke="rgba(196,214,232,0.35)" />
                      <text x={x as number} y={(y as number) + 4} textAnchor="middle" fill="#e2ebf5" fontSize="11" fontFamily="var(--font-mono)">
                        {label}
                      </text>
                    </g>
                  ))}
                  <path d="M118 31 L72 72 M142 31 L188 72 M60 98 L60 137 M200 98 L200 137 M94 85 L166 85 M200 98 L94 145" stroke="url(#nl-wire)" strokeWidth="1.2" fill="none" strokeDasharray="3 3" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Zero ops ---- */}
      <section className="nl-section" id="features">
        <div className="nl-inner">
          <span className="nl-kicker">Platform</span>
          <h2 className="nl-h2">
            Deploy apps and agents with <span className="nl-glow-text">zero ops</span>
          </h2>
          <div className="nl-hosting nv-panel">
            <h3>Hosting and private networking for every piece of your architecture.</h3>
            <div className="nl-chips">
              {['Web services', 'Postgres databases', 'Cron jobs', 'Static sites', 'Background workers', 'Private services', 'WebSockets', 'Persistent disks', 'Env groups', 'Custom domains'].map((c) => (
                <span key={c} className="nl-chip">
                  {c}
                </span>
              ))}
            </div>
          </div>
          <div className="nl-rows">
            <Row
              title="Previews for every pull request"
              body="Open a PR and NAV deploys an isolated copy of the service with its own URL, then tears it down when the PR closes."
              link="Preview environment docs"
              slug="preview-environments"
              art={
                <div className="nl-log">
                  <span className="cm">#142 Add billing page</span>
                  {'\n'}  ↳ api-pr-142.nav.app <span className="ok">● live</span>
                  {'\n'}
                  <span className="cm">#139 Upgrade router</span>
                  {'\n'}  ↳ api-pr-139.nav.app <span className="hl">● building</span>
                  {'\n'}
                  <span className="cm">#131 Fix CSV export</span>
                  {'\n'}  ↳ closed · preview removed
                </div>
              }
            />
            <Row
              title="Load-based autoscaling for traffic spikes"
              body="Set CPU or memory targets and NAV adds instances behind the load balancer when load rises, then scales back down gently."
              link="Autoscaling docs"
              slug="scaling"
              art={
                <div>
                  <span className="nl-chip" style={{ display: 'inline-block' }}>
                    Compute plan · {SERVICE_PLANS[SERVICE_PLANS.length - 1].cpu} vCPU · {formatMemory(SERVICE_PLANS[SERVICE_PLANS.length - 1].memoryMB)}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, marginTop: 18 }}>
                    {[2, 2, 3, 3, 4, 6, 8, 8, 7, 5, 4, 3, 3, 2].map((n, i) => (
                      <div key={i} style={{ flex: 1, height: `${n * 12}%`, borderRadius: 4, background: 'linear-gradient(180deg, #a8ccfc, rgba(168,204,252,0.15))' }} />
                    ))}
                  </div>
                </div>
              }
            />
            <Row
              title="Background workers and cron, without the plumbing"
              body="Run long-lived workers and scheduled jobs from the same repo — every run logged with its exit code and duration."
              link="Cron job docs"
              slug="cron-jobs"
              art={
                <div className="nl-log">
                  0 3 * * *   nightly-report   <span className="ok">succeeded</span> 4.2s{'\n'}*/5 * * * * sync-invoices    <span className="ok">succeeded</span> 1.1s{'\n'}0 * * * *   prune-sessions   <span className="ok">succeeded</span> 0.4s{'\n'}*/5 * * * * sync-invoices    <span className="hl">exit 2</span>      0.9s{'\n'}worker      queue-consumer   <span className="cm">running · 3 instances</span>
                </div>
              }
            />
            <Row
              title="Managed Postgres with backups built in"
              body="Real PostgreSQL clusters with automatic daily backups, one-click restore, IP allow lists and a SQL console in the dashboard."
              link="Postgres docs"
              slug="postgres"
              art={
                <div className="nl-log">
                  <span className="cm">nav-db › SELECT count(*) FROM orders;</span>
                  {'\n'} count{'\n'}-------{'\n'} 48213{'\n'}(1 row · 3 ms){'\n\n'}
                  <span className="ok">backup bkp_9x… completed · 18.4 MB</span>
                </div>
              }
            />
            <Row
              title="Logs and metrics for builds, deploys and live services"
              body="Live-tail build and runtime logs, search history, and watch CPU, memory, requests and latency from day zero."
              link="Observability docs"
              slug="logs-and-metrics"
              art={
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {[['CPU', '#ffe2b2'], ['Memory', '#a8ccfc'], ['Requests / min', '#a8ccfc'], ['p50 latency', '#ffe2b2']].map(([l, c], i) => (
                      <div key={l} className="nl-spark">
                        <small>{l}</small>
                        <Spark seed={i * 2.3 + 1} color={c} />
                      </div>
                    ))}
                  </div>
                </div>
              }
            />
          </div>
        </div>
      </section>

      {/* ---- Statement ---- */}
      <section className="nl-section nl-statement">
        <div className="nl-inner">
          <blockquote>
            “Git push in, production out. Everything in between is <span className="nl-glow-text">ours to run</span> — and yours to own.”
          </blockquote>
          <cite>The NAV principle</cite>
        </div>
      </section>

      {/* ---- Builders grid ---- */}
      <section className="nl-section">
        <div className="nl-inner">
          <span className="nl-kicker">Primitives</span>
          <h2 className="nl-h2">Intuitive infrastructure, designed for builders</h2>
          <p className="nl-lede">Ship software faster with integrated primitives that just work together.</p>
          <div className="nl-grid">
            {BUILDER_TILES.map((t) => (
              <div key={t.title} className="nl-card nv-panel">
                <span className="nl-card-ico">
                  <t.icon strokeWidth={1.6} />
                </span>
                <h3>
                  {t.title}
                  {t.soon && <span className="nl-soon">Soon</span>}
                </h3>
                <p>{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Security ---- */}
      <section className="nl-section">
        <div className="nl-inner">
          <span className="nl-kicker">Security</span>
          <h2 className="nl-h2">Secure and resilient by default</h2>
          <p className="nl-lede">Build products, not hardening checklists.</p>
          <div className="nl-grid three">
            {SECURITY_TILES.map((t) => (
              <div key={t.title} className="nl-card nv-panel">
                <span className="nl-card-ico">
                  <t.icon strokeWidth={1.6} />
                </span>
                <h3>{t.title}</h3>
                <p>{t.body}</p>
              </div>
            ))}
          </div>
          <div className="nl-links">
            <Link to={doc('security')} className="nv-btn nv-hair">
              Security model →
            </Link>
            <Link to={doc('self-hosting')} className="nv-btn nv-hair">
              Self-hosting guide →
            </Link>
          </div>
        </div>
      </section>

      {/* ---- Pricing ---- */}
      <section className="nl-section" id="pricing">
        <div className="nl-inner">
          <span className="nl-kicker">Pricing</span>
          <h2 className="nl-h2">Pay per instance. Nothing else.</h2>
          <p className="nl-lede">Prorated by the second. Self-host NAV and set your own prices — these are the defaults.</p>
          <div className="nl-plans">
            <PlanTable title="Services" unit="Web services, private services, workers & cron jobs" plans={SERVICE_PLANS} />
            <PlanTable title="Postgres" unit="Managed PostgreSQL 15, 16 and 17" plans={DATABASE_PLANS} />
          </div>
        </div>
      </section>

      {/* ---- Final CTA ---- */}
      <section className="nl-final">
        {[
          ['JS', '12%', '22%', '0s'], ['Py', '20%', '68%', '1.2s'], ['Go', '82%', '20%', '0.6s'], ['Rb', '88%', '64%', '2s'],
          ['🐳', '6%', '48%', '1.6s'], ['PG', '76%', '84%', '0.9s'], ['Bn', '30%', '86%', '2.4s'], ['N', '66%', '12%', '1.8s'],
        ].map(([g, x, y, d]) => (
          <span key={g} className="nl-float" style={{ left: x, top: y, animationDelay: d }} aria-hidden="true">
            {g}
          </span>
        ))}
        <div className="nl-inner" style={{ position: 'relative' }}>
          <h2 className="nl-h2">Start building with NAV</h2>
          <p className="nl-lede">Zero ops, zero surprises.</p>
          <Link className="nl-cta nv-btn nv-cta" to={start} style={{ marginTop: 32, height: 50, padding: '0 28px 0 32px', fontSize: 17, gap: 14 }}>
            <span>{signedIn ? 'Open your dashboard' : 'Deploy your app for free'}</span>
            <svg className="nl-arrow" viewBox="0 0 16 11" aria-hidden="true" style={{ width: 16, height: 11 }}>
              <path d="M0 5.5 H14.6 M10.3 1.2 L14.9 5.5 L10.3 9.8" />
            </svg>
          </Link>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="nl-footer">
        <div className="nl-inner">
          <div className="nl-cols">
            <div>
              <h4>Services</h4>
              {PRODUCT_SERVICES.map((s) => (
                <Link key={s.slug} to={doc(s.slug)}>
                  {s.title}
                </Link>
              ))}
              <Link to={doc('persistent-disks')}>Persistent Disks</Link>
            </div>
            <div>
              <h4>Features</h4>
              {PRODUCT_FEATURES.map(([t, s]) => (
                <Link key={t} to={doc(s)}>
                  {t}
                </Link>
              ))}
              <Link to={doc('docker')}>Docker support</Link>
            </div>
            <div>
              <h4>Developers</h4>
              <Link to="/docs">Docs</Link>
              <Link to={doc('quickstarts')}>Framework Quickstarts</Link>
              <Link to={doc('cli')}>NAV CLI</Link>
              <Link to={doc('rest-api')}>REST API</Link>
              <Link to={doc('changelog')}>Changelog</Link>
            </div>
            <div>
              <h4>Resources</h4>
              <a href="#pricing">Pricing</a>
              <Link to={doc('self-hosting')}>Self-hosting</Link>
              <Link to={doc('security')}>Security</Link>
              <Link to={doc('faq')}>FAQ</Link>
            </div>
            <div>
              <h4>Platform</h4>
              <Link to={start}>{signedIn ? 'Dashboard' : 'Sign up'}</Link>
              <Link to="/login">Log in</Link>
              <a href="#how">How it works</a>
              <a href="#features">Features</a>
            </div>
            <div>
              <h4>Compare</h4>
              <Link to={doc('faq')}>NAV vs. managed PaaS</Link>
              <Link to={doc('self-hosting')}>NAV vs. raw VMs</Link>
              <Link to={doc('docker')}>NAV vs. plain Docker</Link>
            </div>
          </div>
          <div className="nl-bottom">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <LogoMark className="size-5" /> © {new Date().getFullYear()} NAV. Open infrastructure.
            </span>
            <span className={`nl-status${status === 'down' ? ' down' : ''}`} role="status">
              <i aria-hidden="true" />
              {status === 'checking' ? 'Checking status…' : status === 'up' ? 'All systems operational' : 'Control plane unreachable'}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
