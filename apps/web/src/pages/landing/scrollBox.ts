/**
 * Scroll-linked effects without layout reads on scroll.
 *
 * Calling getBoundingClientRect() inside a scroll handler forces the browser to recompute layout for the whole
 * page whenever any style changed since the last frame, which on a long page costs most of a frame on a phone.
 * `watchBoxes` measures the elements once (and again whenever the page is resized or its height changes), stores
 * their position in document coordinates, and calls `onFrame` at most once per animation frame with boxes whose
 * `top` is derived from `window.scrollY` alone.
 */
export interface Box {
  /** Distance from the top of the viewport, like DOMRect.top. */
  top: number;
  height: number;
  bottom: number;
}

export function watchBoxes(elements: () => HTMLElement[], onFrame: (boxes: Box[], viewportHeight: number) => void): () => void {
  let docBoxes: { top: number; height: number }[] = [];
  let vh = window.innerHeight;
  let raf = 0;
  // Read in the scroll event (start of the frame, layout still clean), never inside the animation frame.
  let y = window.scrollY;

  const frame = () => {
    raf = 0;
    onFrame(docBoxes.map((b) => ({ top: b.top - y, height: b.height, bottom: b.top - y + b.height })), vh);
  };
  // Always (re)schedule: a frame requested while the tab was hidden may never run.
  const schedule = () => {
    y = window.scrollY;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  };
  const measure = () => {
    y = window.scrollY;
    vh = window.innerHeight;
    docBoxes = elements().map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + y, height: r.height };
    });
    schedule();
  };

  measure();
  frame();
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', measure);
  // Content above can change height (fonts loading, an accordion opening), which moves everything below it.
  const ro = new ResizeObserver(measure);
  ro.observe(document.body);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', measure);
  };
}

/** Sets a custom property only when its value changed, so an unchanged frame invalidates no styles. */
export function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/**
 * Adds `k-off` to each element while it is outside the viewport (plus a margin). The stylesheet pauses every
 * animation under `.k-off`, so sections nobody is looking at stop costing style and paint work each frame.
 */
export function pauseOffscreen(elements: Element[], margin = '200px'): () => void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.target.classList.toggle('k-off', !e.isIntersecting);
    },
    { rootMargin: margin },
  );
  elements.forEach((el) => io.observe(el));
  return () => io.disconnect();
}
