import { useEffect, useRef, useState } from 'react';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamOptions {
  /** Called on every (re)connect so callers can resume (e.g. `?after=<lastId>`). */
  url: () => string;
  /** Named SSE events → handler with parsed JSON (or raw string if not JSON). */
  events: Record<string, (data: unknown) => void>;
  /** Events after which the stream is considered complete (no reconnect). */
  endEvents?: string[];
  onState?: (s: StreamState) => void;
  maxBackoffMs?: number;
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Opens a Server-Sent Events stream over fetch() (not EventSource: fetch streams behave the same in every
 * browser and embedded webview, and reconnection is fully under our control). Exponential-backoff
 * reconnects; returns a disposer.
 */
export function openStream(opts: StreamOptions): () => void {
  let ctl: AbortController | null = null;
  let disposed = false;
  let ended = false;
  // True while the page is hidden for navigation (unloading, or parked in the back/forward cache).
  let paused = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const max = opts.maxBackoffMs ?? 30_000;
  const endEvents = new Set(opts.endEvents ?? []);

  const dispatch = (event: string, data: string) => {
    if (endEvents.has(event)) {
      ended = true;
      ctl?.abort();
      opts.onState?.('closed');
      return;
    }
    opts.events[event]?.(parse(data));
  };

  const retry = () => {
    if (disposed || ended || paused) return;
    attempt++;
    const delay = Math.min(max, 1000 * 2 ** Math.min(attempt - 1, 5)) * (0.75 + Math.random() * 0.5);
    opts.onState?.('reconnecting');
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    if (disposed || ended || paused) return;
    opts.onState?.(attempt === 0 ? 'connecting' : 'reconnecting');
    ctl = new AbortController();
    try {
      const res = await fetch(opts.url(), { credentials: 'include', headers: { accept: 'text/event-stream' }, cache: 'no-store', signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      attempt = 0;
      opts.onState?.('open');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let event = 'message';
      let data: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (data.length) dispatch(event, data.join('\n'));
            event = 'message';
            data = [];
          } else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          // `id:`, `retry:` and `:` comments need no handling: callers resume via opts.url().
        }
        if (ended || disposed) return;
      }
    } catch {
      if (disposed || ended) return;
    }
    retry();
  };

  // A page that is navigated away from can be kept alive in the back/forward cache with its stream still open.
  // Browsers allow only a handful of connections per host, so a few such pages would starve every later request
  // and the dashboard would stop loading. Close the stream when the page is hidden and reopen it if it comes back.
  const onHide = () => {
    paused = true;
    if (timer) clearTimeout(timer);
    ctl?.abort();
  };
  const onShow = () => {
    if (!paused || disposed || ended) return;
    paused = false;
    attempt = 0;
    void connect();
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);

  void connect();
  return () => {
    disposed = true;
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    if (timer) clearTimeout(timer);
    ctl?.abort();
  };
}

/**
 * React wrapper around openStream. Handlers are read through a ref so changing them doesn't reconnect;
 * pass `key` (e.g. the URL inputs) to control reconnection. `null` key disables the stream.
 */
export function useEventStream(
  key: string | null,
  opts: Omit<StreamOptions, 'onState'>,
): StreamState {
  const [state, setState] = useState<StreamState>('closed');
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    if (key === null) {
      setState('closed');
      return;
    }
    const names = Object.keys(ref.current.events);
    const events: Record<string, (d: unknown) => void> = {};
    for (const n of names) events[n] = (d) => ref.current.events[n]?.(d);
    return openStream({
      url: () => ref.current.url(),
      events,
      endEvents: ref.current.endEvents,
      maxBackoffMs: ref.current.maxBackoffMs,
      onState: setState,
    });
  }, [key]);

  return state;
}
