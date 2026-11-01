import { useEffect, useState } from 'react';
import ShapeWaves from '@/components/reactbits/ShapeWaves';
import { LogoMark } from '@/components/Logo';
import './websiteIntro.css';

/** How long the intro stays fully visible before it starts to fade, and how long the fade takes. */
const INTRO_MS = 2500;
const EXIT_MS = 600;
/** When WebGPU is missing or fails, the static fallback is shown only briefly. */
const FALLBACK_MS = 900;
const BRAND_FONT = "'Inter Variable', Inter, system-ui, sans-serif";

/**
 * Decided once, when the app first loads: only a fresh visit that lands on the homepage gets the intro, and never
 * under prefers-reduced-motion. Internal navigation never re-evaluates this, and `finished` stops StrictMode
 * double-mounts or remounts from replaying it within the same page load. A new tab or reload starts fresh.
 */
const PLAY_ON_LOAD =
  typeof window !== 'undefined' &&
  window.location.pathname === '/' &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let finished = false;

type Phase = 'show' | 'exit' | 'done';

/**
 * Full-screen ShapeWaves brand intro over the already-mounted homepage. Shows for 2.5 s, fades out over 600 ms,
 * then unmounts (which also releases the WebGPU resources). Falls back to a brief static screen without WebGPU.
 */
export function WebsiteIntro() {
  const [phase, setPhase] = useState<Phase>(() => (PLAY_ON_LOAD && !finished ? 'show' : 'done'));
  const [fallback, setFallback] = useState(() => typeof navigator !== 'undefined' && !('gpu' in navigator));
  // The text cutout is drawn once the brand font is ready, so the mask never uses a fallback face.
  const [brand, setBrand] = useState('');

  const showing = phase === 'show';
  const holdMs = fallback ? FALLBACK_MS : INTRO_MS;

  useEffect(() => {
    if (!showing) return;
    const t = window.setTimeout(() => setPhase('exit'), holdMs);
    return () => window.clearTimeout(t);
  }, [showing, holdMs]);

  useEffect(() => {
    if (phase !== 'exit') return;
    const t = window.setTimeout(() => {
      finished = true;
      setPhase('done');
    }, EXIT_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Hold the page still underneath while the intro is fully visible; release it as soon as the fade begins.
  useEffect(() => {
    if (!showing) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => { root.style.overflow = previous; };
  }, [showing]);

  // Escape skips straight to the fade.
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPhase('exit'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showing]);

  useEffect(() => {
    if (phase === 'done' || fallback) return;
    let cancelled = false;
    const fonts = document.fonts;
    const apply = () => { if (!cancelled) setBrand('nav'); };
    if (fonts?.load) fonts.load(`700 120px ${BRAND_FONT}`).then(apply, apply);
    else apply();
    return () => { cancelled = true; };
  }, [phase, fallback]);

  if (phase === 'done') return null;

  return (
    <div className={`nav-intro${phase === 'exit' ? ' is-exiting' : ''}`} style={{ '--intro-exit': `${EXIT_MS}ms` } as React.CSSProperties} aria-hidden="true">
      {fallback ? (
        <div className="nav-intro__fallback">
          <LogoMark className="nav-intro__mark" />
        </div>
      ) : (
        <ShapeWaves
          text={brand}
          fontFamily={BRAND_FONT}
          fontWeight={700}
          textSize={0.3}
          shapes="mixed"
          cellSize={10}
          dotSize={0.75}
          color="#929292"
          hoverColor="#ffffff"
          backgroundColor="#000000"
          speed={1}
          scale={1}
          contrast={1}
          brightness={0.4}
          flow={0}
          direction={0}
          fade={0.25}
          interactive
          splashRadius={40}
          splashStrength={0.4}
          glow={0.35}
          intro
          introDuration={1.6}
          paused={false}
          onError={() => setFallback(true)}
        />
      )}
    </div>
  );
}
