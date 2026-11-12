import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, ArrowUp, Check, ChevronRight, Container,
  Database, Fingerprint, Globe, Layers, Lock,
  Menu, Moon, Network, Plus, Search, Sun, Users, Webhook, Workflow, X,
} from 'lucide-react';
import { SERVICE_PLANS } from '@nav/shared';
import { useMe } from '@/api/auth';
import {
  siAngular, siBun, siDeno, siDjango, siDocker, siGit, siGithub, siGitlab, siGo, siNextdotjs, siNodedotjs, siPhp,
  siPostgresql, siPython, siReact, siRuby, siRust, siSvelte, siVuedotjs, type SimpleIcon,
} from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import { Github } from '@/components/GithubIcon';
import { Logo } from '@/components/Logo';
import { formatMemory } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { useTitle } from '@/lib/useTitle';
import { Story } from './landing/Story';
import { pauseOffscreen, setVar, watchBoxes } from './landing/scrollBox';
import './landing/kivo.css';

type Icon = typeof Globe | typeof Github;

const TYPED = ['web services', 'background workers', 'cron jobs', 'Postgres', 'static sites'];

/** Illustrative services for the hero board (UI mock, not live data). */
const BOARD: { name: string; kind: string; icon: Icon; metric: string; value: string; pts: number[] }[] = [
  { name: 'api', kind: 'Web service', icon: Globe, metric: 'Requests', value: '1.2k/m', pts: [14, 20, 12, 22, 16, 24, 15, 21, 26, 18, 24] },
  { name: 'queue-worker', kind: 'Background worker', icon: Workflow, metric: 'Jobs', value: '640/m', pts: [18, 12, 20, 9, 16, 22, 12, 18, 10, 20, 14] },
  { name: 'main-db', kind: 'Postgres', icon: Database, metric: 'Storage', value: '2.4 GB', pts: [6, 8, 9, 11, 12, 14, 16, 17, 19, 21, 23] },
  { name: 'docs-site', kind: 'Static site', icon: Layers, metric: 'Bandwidth', value: '3.1 GB', pts: [10, 16, 13, 20, 14, 12, 22, 17, 24, 15, 21] },
];

/** Runtime band: technologies NAV builds and runs, natively or from a Dockerfile. */
const BAND_ROWS: SimpleIcon[][] = [
  [siNodedotjs, siPython, siGo, siBun, siDocker, siPostgresql, siDjango, siSvelte, siRuby],
  [siPhp, siReact, siVuedotjs, siAngular, siNextdotjs, siRust, siDeno, siGithub, siGitlab],
];

const SECURITY: { icon: Icon; title: string; body: string }[] = [
  { icon: Container, title: 'Hardened containers', body: 'Dropped capabilities plus CPU, memory and process limits.' },
  { icon: Lock, title: 'Scrubbed environments', body: 'Instances start with only their own variables.' },
  { icon: Webhook, title: 'Verified webhooks', body: 'GitHub signatures checked in constant time.' },
  { icon: Fingerprint, title: 'Hashed passwords', body: 'Stored as scrypt hashes, never in plain text.' },
  { icon: Users, title: 'Workspace roles', body: 'Each member’s role decides what they can change.' },
  { icon: Network, title: 'Private by default', body: 'No public route unless you add one.' },
];

const FAQ: [string, string][] = [
  ['Where does NAV run?', 'On machines you control. The control plane, agent and edge proxy are plain Node processes backed by one Postgres database.'],
  ['What can I deploy?', 'Web services, static sites, background workers, cron jobs, private services and Postgres databases, from Git or a Dockerfile.'],
  ['How do deploys stay zero-downtime?', 'A new instance has to pass its health check first. The edge then moves traffic over and only afterwards stops the old instance.'],
  ['Do I need Docker?', 'No. The agent can run instances as hardened Docker containers or as supervised processes, depending on the host.'],
  ['How do rollbacks work?', 'Every successful build is kept. Choose an earlier deploy in the dashboard or run nav rollback, and that exact artifact is redeployed.'],
  ['Can I keep infrastructure in code?', 'Yes. A nav.yaml blueprint declares services, databases and env groups, and NAV syncs them when the file changes.'],
];

function sparkPath(pts: number[], w = 200, h = 30) {
  const max = Math.max(...pts);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)} ${(h - (p / max) * h).toFixed(1)}`).join(' ');
}

function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const els = root.current?.querySelectorAll('.k-rv');
    if (!els?.length) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [root]);
}

/** Types and deletes the rotating hero phrase. */
function useTyped(words: string[]) {
  const [text, setText] = useState(words[0]);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = 0;
    let n = words[0].length;
    let deleting = false;
    let t = 0;
    const tick = () => {
      const w = words[i];
      if (!deleting && n === w.length) { deleting = true; t = window.setTimeout(tick, 2200); return; }
      if (deleting && n === 0) { deleting = false; i = (i + 1) % words.length; t = window.setTimeout(tick, 260); return; }
      n += deleting ? -1 : 1;
      setText(words[i].slice(0, n));
      t = window.setTimeout(tick, deleting ? 38 : 75);
    };
    t = window.setTimeout(tick, 1800);
    return () => window.clearTimeout(t);
  }, [words]);
  return text;
}

/**
 * The rotating hero phrase. It owns its own state on purpose: the text changes every 38 to 75 ms, and keeping that
 * state in the page component re-rendered the whole landing page (every section and mock) on each keystroke.
 */
function TypedPhrase() {
  const typed = useTyped(TYPED);
  return <span className="k-typed" aria-hidden="true">{typed}<span className="k-caret" /></span>;
}

function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

function Cross() {
  return (
    <>
      <span className="k-cross l" aria-hidden="true" />
      <span className="k-cross r" aria-hidden="true" />
    </>
  );
}

function HeroBoard() {
  const [busy, setBusy] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setDrawn(true), 300); return () => window.clearTimeout(t); }, []);
  const order = useRef(0);
  useInterval(() => {
    const i = order.current++ % BOARD.length;
    setBusy(i);
    window.setTimeout(() => setBusy((b) => (b === i ? null : b)), 1700);
  }, 4200);
  return (
    <div className="k-board-wrap">
      <div className="k-push">$ git push</div>
      <div className="k-board">
        <div className="k-board-label">PRODUCTION</div>
        <div className="k-board-grid">
          {BOARD.map((s, i) => {
            const I = s.icon;
            const isBusy = busy === i;
            return (
              <div key={s.name} className={`k-svc${drawn && !isBusy ? ' live' : ''}`}>
                <div className="k-svc-top">
                  <I /> {s.name}
                  <span className={`k-state${isBusy ? ' busy' : ''}`}>{isBusy ? 'Deploying' : 'Live'}</span>
                </div>
                <div className="k-svc-kind">{s.kind}</div>
                <svg className="k-spark" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
                  <path d={sparkPath(s.pts)} pathLength={400} />
                </svg>
                <div className="k-svc-foot"><span>{s.metric}</span><b>{s.value}</b></div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type FooterGroup = { title: string; links: [string, string][] };

/** Footer columns; each column can stack more than one group. '@start' resolves to sign-up or the dashboard. */
const FOOTER: FooterGroup[][] = [
  [{ title: 'Services', links: [['Web services', '/docs#web-services'], ['Private services', '/docs#private-services'], ['Background workers', '/docs#background-workers'], ['Cron jobs', '/docs#cron-jobs'], ['Static sites', '/docs#static-sites'], ['Postgres', '/docs#postgres'], ['Persistent disks', '/docs#persistent-disks'], ['Environment variables', '/docs#environment-variables']] }],
  [{ title: 'Features', links: [['Preview environments', '/docs#preview-environments'], ['Infrastructure as code', '/docs#infrastructure-as-code'], ['Zero-downtime deploys', '/docs#deploys'], ['Autoscaling', '/docs#scaling'], ['Custom domains', '/docs#custom-domains'], ['Private networking', '/docs#private-network'], ['Logs and metrics', '/docs#logs-and-metrics']] }],
  [{ title: 'Developers', links: [['Getting started', '/docs#getting-started'], ['Quickstarts', '/docs#quickstarts'], ['NAV CLI', '/docs#cli'], ['REST API', '/docs#rest-api'], ['Docker support', '/docs#docker'], ['Changelog', '/docs#changelog']] }],
  [{ title: 'Resources', links: [['Pricing', '#pricing'], ['Examples', '/docs#examples'], ['Architecture', '/docs#architecture'], ['FAQ', '/docs#faq'], ['Self-hosting guide', '/docs#self-hosting']] }],
  [
    { title: 'Runtimes', links: [['Node.js', '/docs#runtime-node'], ['Python', '/docs#runtime-python'], ['Go', '/docs#runtime-go'], ['Bun', '/docs#runtime-bun'], ['Dockerfile', '/docs#dockerfile']] },
    { title: 'Platform', links: [['Control plane', '/docs#control-plane'], ['Agent', '/docs#agent'], ['Edge proxy', '/docs#edge-proxy']] },
  ],
  [
    { title: 'Account', links: [['Sign up', '@start'], ['Log in', '/login']] },
    { title: 'Trust', links: [['Security model', '/docs#security-model'], ['Hardened containers', '/docs#hardened-containers'], ['Verified webhooks', '/docs#verified-webhooks']] },
  ],
];

/** `cl`: darker logo colour for the light theme, for brands whose own colour is near-white. */
type FloatTile = { c: string; cl?: string; brand: SimpleIcon };

/**
 * Tiles around the closing call to action, as mirrored left/right pairs ordered top to bottom.
 * x is the left tile's position (the right one sits at 100 - x); s is the parallax speed both share.
 */
const FLOAT_PAIRS: { x: number; y: number; s: number; tiles: [FloatTile, FloatTile] }[] = [
  { x: 31, y: 3, s: 1.2, tiles: [{ c: '#4b8bbe', brand: siPython }, { c: '#00add8', brand: siGo }] },
  { x: 14, y: 9, s: -0.6, tiles: [{ c: '#f05033', brand: siGit }, { c: '#ff3e00', brand: siSvelte }] },
  { x: 5, y: 23, s: 0.9, tiles: [{ c: '#2496ed', brand: siDocker }, { c: '#44b78b', brand: siDjango }] },
  { x: 13, y: 44, s: -1.1, tiles: [{ c: '#cc342d', brand: siRuby }, { c: '#8892bf', brand: siPhp }] },
  { x: 25, y: 66, s: 0.7, tiles: [{ c: '#fbf0df', cl: '#3b2a1a', brand: siBun }, { c: '#dd0031', brand: siAngular }] },
  { x: 7, y: 77, s: -0.9, tiles: [{ c: '#5fa04e', brand: siNodedotjs }, { c: '#4fc08d', brand: siVuedotjs }] },
  { x: 40, y: 86, s: 1.0, tiles: [{ c: '#61dafb', brand: siReact }, { c: '#6b8fef', brand: siPostgresql }] },
  { x: 21, y: 94, s: -0.5, tiles: [{ c: '#f0f0f0', cl: '#181717', brand: siGithub }, { c: '#dea584', brand: siRust }] },
];

/**
 * Closing call to action: a framed panel ringed by tech tiles. As the section scrolls in, the tiles pop in pair by
 * mirrored pair from the top down; as it scrolls out through the top they pop out in the same order, and scrolling
 * back reverses either. Tiles also drift at their own parallax speed.
 */
function StartCta({ start, signedIn }: { start: string; signedIn: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.setProperty('--ni', '99');
      el.style.setProperty('--no', '99');
      return;
    }
    const pairs = FLOAT_PAIRS.length;
    return watchBoxes(() => [el], ([r], vh) => {
      // -1 when the section is entering from below, 0 when centred, 1 when leaving at the top.
      const p = Math.max(-1.2, Math.min(1.2, (vh / 2 - (r.top + r.height / 2)) / ((vh + r.height) / 2)));
      setVar(el, '--p', p.toFixed(3));
      // Pairs that have entered (counting from the top as the section rises into view) and pairs still on screen
      // (counting from the bottom as it leaves through the top). Whole numbers, so each pair pops rather than fades.
      const span = Math.min(vh, r.height) * 0.8;
      const entered = Math.floor(Math.max(0, Math.min(1, (vh - r.top) / span)) * (pairs + 0.999));
      const remaining = Math.floor(Math.max(0, Math.min(1, r.bottom / span)) * (pairs + 0.999));
      setVar(el, '--ni', String(entered));
      setVar(el, '--no', String(remaining));
    });
  }, []);
  return (
    <section ref={ref} className="k-start" aria-labelledby="k-start-title">
      <div className="k-floats" aria-hidden="true">
        {FLOAT_PAIRS.flatMap((pair, i) =>
          pair.tiles.map((t, side) => (
            <span
              key={t.brand.slug}
              className="k-float"
              title={t.brand.title}
              style={{
                left: `${side ? 100 - pair.x : pair.x}%`,
                top: `${pair.y}%`,
                '--s': pair.s,
                '--c': t.c,
                ...(t.cl ? { '--cl': t.cl } : {}),
                '--i': i,
                '--j': FLOAT_PAIRS.length - 1 - i,
                '--d': `${(i % 4) * -1.4}s`,
              } as React.CSSProperties}
            >
              <span className="k-float-in"><BrandIcon icon={t.brand} /></span>
            </span>
          )),
        )}
      </div>
      <div className="k-start-box k-rv">
        <h2 id="k-start-title">Start building with NAV</h2>
        <p>Your servers, zero babysitting.</p>
        <Link to={start} className="k-btn k-btn-solid">{signedIn ? 'Open your dashboard' : 'Deploy your first service'} <ChevronRight /></Link>
      </div>
    </section>
  );
}

export function LandingPage() {
  useTitle(null);
  const me = useMe();
  const navigate = useNavigate();
  const signedIn = !!me.data;
  const start = signedIn ? '/app' : '/signup';
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const [showTop, setShowTop] = useState(false);
  const [hourly, setHourly] = useState(false);
  const [open, setOpen] = useState(0);
  useReveal(rootRef);
  // Sections outside the viewport pause their animations (see .k-off in kivo.css).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return pauseOffscreen([...root.querySelectorAll('.k-hero, .k-band, .k-sec, .st-ch, .k-start, .k-foot')]);
  }, []);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 900);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); navigate('/docs'); }
      if (e.key === 'Escape') setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [navigate]);

  const links: [string, string][] = [['Product', '#product'], ['Platform', '#platform'], ['Pricing', '#pricing'], ['Security', '#security'], ['Docs', '/docs']];
  const plans = SERVICE_PLANS.filter((p) => ['free', 'starter', 'standard'].includes(p.id));
  const planCopy: Record<string, { blurb: string; items: string[]; cta: string }> = {
    free: { blurb: 'For side projects and trying NAV out.', items: ['Web services and static sites', 'Deploy on git push', 'TLS on a NAV subdomain', 'Build and runtime logs'], cta: 'Start for free' },
    starter: { blurb: 'For production apps with steady traffic.', items: ['Zero-downtime deploys', 'Custom domains and TLS', 'Cron jobs and workers', 'Persistent disks', 'One-click rollbacks'], cta: 'Choose Starter' },
    standard: { blurb: 'For services that need headroom.', items: ['Everything in Starter', 'Autoscaling', 'Preview environments', 'Private networking', 'Metrics for every instance'], cta: 'Choose Standard' },
  };
  const navLink = (label: string, href: string, cls?: string) =>
    href.startsWith('/') ? <Link key={label} to={href} className={cls} onClick={() => setMenu(false)}>{label}</Link>
      : <a key={label} href={href} className={cls} onClick={() => setMenu(false)}>{label}</a>;

  return (
    <div ref={rootRef} className={`k${menu ? ' menu-open' : ''}`} data-theme={theme}>
      <div className="k-grid-bg" aria-hidden="true" />

      <header className="k-nav">
        <div className="k-nav-inner">
          <Link to="/" className="k-brand" aria-label="NAV home"><Logo /></Link>
          <nav className="k-links" aria-label="Primary">{links.map(([l, h]) => navLink(l, h))}</nav>
          <div className="k-nav-right">
            <button type="button" className="k-theme" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </button>
            <Link to="/docs" className="k-search"><Search /> Search docs <span className="k-kbd">Ctrl K</span></Link>
            {!signedIn && <Link to="/login" className="k-login">Log in</Link>}
            <Link to={start} className="k-cta-nav">{signedIn ? 'Dashboard' : 'Get started'} <ArrowRight /></Link>
          </div>
          <button type="button" className="k-burger" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            {menu ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </header>
      <div className="k-sheet" aria-hidden={!menu} inert={!menu}>
        {links.map(([l, h]) => navLink(l, h))}
        {!signedIn && navLink('Log in', '/login')}
        <button type="button" className="k-theme-row" onClick={toggleTheme}>
          {theme === 'dark' ? <Sun /> : <Moon />} {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
        <Link to={start} className="k-btn k-btn-solid" onClick={() => setMenu(false)}>{signedIn ? 'Open dashboard' : 'Get started'} <ArrowRight /></Link>
      </div>

      <main className="k-col">
        {/* ---- Hero ---- */}
        <section className="k-hero" id="product">
          <div>
            <h1 className="k-h1">
              Push to deploy<br />
              <span className="sr-only">web services, workers, cron jobs, Postgres and static sites</span>
              <TypedPhrase />
            </h1>
            <p className="k-lede">Connect a repository and NAV builds it, health-checks it and routes traffic to it, on servers you control.</p>
            <div className="k-actions">
              <Link to={start} className="k-btn k-btn-solid">{signedIn ? 'Open dashboard' : 'Start deploying'} <ChevronRight /></Link>
              <Link to="/docs" className="k-btn k-btn-line">Read the docs</Link>
            </div>
          </div>
          <HeroBoard />
        </section>

        {/* ---- Scroll story ---- */}
        <Story />
      </main>

      {/* ---- Runtime band ---- */}
      <section className="k-band">
        <h2 className="k-band-title">Whatever you build,<br />run it on NAV.</h2>
        <p className="sr-only">NAV runs Node.js, Python, Go, Bun, Ruby, PHP, Rust and Deno services, frameworks such as Django, React, Vue, Angular, Svelte and Next.js, anything with a Dockerfile, and Postgres, deploying from GitHub or GitLab.</p>
        <div className="k-band-rows" aria-hidden="true">
          {BAND_ROWS.map((row, r) => (
            <div key={r} className="k-band-row">
              {[...row, ...row].map((icon, i) => (
                <span key={i} className="k-chip" title={icon.title}><BrandIcon icon={icon} /></span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <main className="k-col">
        {/* ---- Pricing ---- */}
        <section className="k-sec" id="pricing" style={{ textAlign: 'center' }}>
          <Cross />
          <span className="k-eyebrow k-rv">Pricing</span>
          <h2 className="k-h2 k-rv" style={{ marginInline: 'auto' }}>Plans that grow with your service</h2>
          <p className="k-lede k-rv" style={{ marginInline: 'auto' }}>Each service picks its own plan, and you can change it at any time.</p>
          <div className="k-toggle k-rv">
            <div className="k-filters" role="group" aria-label="Billing period">
              <button type="button" aria-pressed={!hourly} onClick={() => setHourly(false)}>Monthly</button>
              <button type="button" aria-pressed={hourly} onClick={() => setHourly(true)}>Hourly</button>
            </div>
            <span className="k-save">Prorated by the second</span>
          </div>
          <div className="k-plans" style={{ textAlign: 'left' }}>
            {plans.map((p) => {
              const c = planCopy[p.id];
              const pop = p.id === 'standard';
              const price = hourly ? (p.priceMonthly / 730).toFixed(4) : String(p.priceMonthly);
              return (
                <div key={p.id} className={`k-plan k-rv${pop ? ' pop' : ''}`}>
                  <div className="k-plan-name">{p.name}{pop && <em>MOST POPULAR</em>}</div>
                  <p>{c?.blurb}</p>
                  <div className="k-price"><b>${price}</b><span>/ {hourly ? 'hour' : 'month'}</span></div>
                  <div className="k-spec">{p.cpu} CPU · {formatMemory(p.memoryMB)} RAM</div>
                  <ul>{c?.items.map((i) => <li key={i}><Check />{i}</li>)}</ul>
                  <Link to={start} className={`k-btn ${pop ? 'k-btn-solid' : 'k-btn-line'}`}>{c?.cta}</Link>
                </div>
              );
            })}
          </div>
          <div className="k-center"><Link to="/docs" className="k-link">Compare every plan <ArrowRight /></Link></div>
        </section>

        {/* ---- Security ---- */}
        <section className="k-sec k-sec-tight" id="security">
          <Cross />
          <div className="k-head-row k-rv">
            <div>
              <span className="k-eyebrow">Security</span>
              <h2 className="k-h2">Secure by default</h2>
            </div>
            <Link to="/docs#security" className="k-link">Read the security model <ArrowRight /></Link>
          </div>
          <div className="k-sec6 k-rv">
            {SECURITY.map(({ icon: I, title, body }) => (
              <div key={title} className="k-sec6-item"><i><I /></i><h3>{title}</h3><p>{body}</p></div>
            ))}
          </div>
        </section>

        {/* ---- FAQ ---- */}
        <section className="k-sec">
          <Cross />
          <div className="k-faq">
            <div className="k-faq-side k-rv">
              <span className="k-eyebrow">FAQ</span>
              <h2 className="k-h2">Questions, answered</h2>
              <p className="k-lede">Still curious? The docs cover every part of the platform in depth.</p>
              <Link to="/docs" className="k-btn k-btn-line">Read the docs</Link>
            </div>
            <div className="k-rv">
              {FAQ.map(([q, a], i) => (
                <div key={q} className={`k-qa${open === i ? ' open' : ''}`}>
                  <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                    <small>{String(i + 1).padStart(2, '0')}</small>{q}<Plus />
                  </button>
                  <div className="k-qa-body"><div><p>{a}</p></div></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- Closing call to action ---- */}
        <StartCta start={start} signedIn={signedIn} />

        {/* ---- Footer ---- */}
        <footer className="k-foot">
          <div className="k-foot-grid">
            {FOOTER.map((col) => (
              <div key={col[0].title} className="k-foot-col">
                {col.map((g) => (
                  <div key={g.title} className="k-foot-group">
                    <h3>{g.title}</h3>
                    {g.links.map(([l, href]) => {
                      // Signed-in visitors get their dashboard and account instead of sign-up / log-in.
                      const to = href === '@start' ? start : signedIn && href === '/login' ? '/account' : href;
                      const label = href === '@start' ? (signedIn ? 'Dashboard' : 'Sign up') : signedIn && href === '/login' ? 'Account settings' : l;
                      return to.startsWith('#') ? <a key={l} href={to}>{label}</a> : <Link key={l} to={to}>{label}</Link>;
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="k-foot-bottom">
            <div className="k-foot-left">
              <Link to="/" aria-label="NAV home" className="k-foot-mark"><Logo /></Link>
              <span className="k-foot-copy">© {new Date().getFullYear()} NAV. All rights reserved.</span>
            </div>
            <nav className="k-foot-legal" aria-label="Footer">
              <Link to="/docs">Docs</Link>
              <Link to="/docs#security">Security</Link>
              <Link to="/docs#self-hosting">Self-hosting</Link>
              <Link to="/docs#changelog">Changelog</Link>
            </nav>
          </div>
        </footer>
      </main>

      <button type="button" className={`k-top${showTop ? ' show' : ''}`} aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <ArrowUp />
      </button>
    </div>
  );
}
