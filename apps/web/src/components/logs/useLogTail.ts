import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLine } from '@nav/shared';
import { useEventStream, type StreamState } from '@/api/sse';
import { errorMessage } from '@/api/client';

export const MAX_LINES = 5000;

export interface LogTailOptions {
  /** Changing the key resets the buffer and reconnects. `null` disables everything. */
  key: string | null;
  /** Initial page / older pages. `before` is only passed when loading older lines. */
  fetchPage: (q: { before?: number; limit: number }) => Promise<{ items: LogLine[] }>;
  /** SSE URL builder; receives the last seen id for resumption. Return null to not stream. */
  streamUrl: ((after: number | undefined) => string) | null;
  /** Live tail on/off (pausing disconnects the stream; it resumes from the last id). */
  live?: boolean;
  supportsOlder?: boolean;
  endEvents?: string[];
  pageSize?: number;
  maxLines?: number;
}

export interface LogTail {
  lines: LogLine[];
  state: StreamState;
  loading: boolean;
  error: string | null;
  loadOlder: () => Promise<void>;
  loadingOlder: boolean;
  hasOlder: boolean;
  ended: boolean;
  clear: () => void;
}

function mergeAppend(prev: LogLine[], incoming: LogLine[], cap: number): LogLine[] {
  if (!incoming.length) return prev;
  const lastId = prev.length ? prev[prev.length - 1].id : -Infinity;
  const fresh = incoming.filter((l) => l.id > lastId).sort((a, b) => a.id - b.id);
  if (!fresh.length) return prev;
  const next = prev.concat(fresh);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function useLogTail(opts: LogTailOptions): LogTail {
  const { key, live = true, supportsOlder = true, pageSize = 200, maxLines = MAX_LINES } = opts;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastIdRef = useRef<number | undefined>(undefined);
  const pending = useRef<LogLine[]>([]);
  const raf = useRef<ReturnType<typeof setTimeout> | null>(null);

  // initial history
  useEffect(() => {
    setLines([]);
    setReady(false);
    setEnded(false);
    setError(null);
    lastIdRef.current = undefined;
    if (key === null) return;
    let cancelled = false;
    setLoading(true);
    optsRef.current
      .fetchPage({ limit: pageSize })
      .then((res) => {
        if (cancelled) return;
        const items = [...res.items].sort((a, b) => a.id - b.id);
        setLines(items.slice(-maxLines));
        lastIdRef.current = items.length ? items[items.length - 1].id : undefined;
        setHasOlder(supportsOlder && items.length >= pageSize);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [key, pageSize, maxLines, supportsOlder]);

  const flush = useCallback(() => {
    raf.current = null;
    const batch = pending.current;
    pending.current = [];
    setLines((prev) => mergeAppend(prev, batch, maxLines));
  }, [maxLines]);

  useEffect(
    () => () => {
      if (raf.current) clearTimeout(raf.current);
    },
    [],
  );

  const streamEnabled = key !== null && ready && live && !!opts.streamUrl && !ended;
  const state = useEventStream(streamEnabled ? `${key}` : null, {
    url: () => optsRef.current.streamUrl?.(lastIdRef.current) ?? '',
    endEvents: opts.endEvents,
    events: {
      log: (data) => {
        if (typeof data !== 'object' || data === null || !('id' in data)) return;
        const line = data as LogLine;
        if (lastIdRef.current !== undefined && line.id <= lastIdRef.current) return;
        lastIdRef.current = line.id;
        pending.current.push(line);
        // setTimeout, not rAF: rAF is paused in background tabs.
        if (raf.current == null) raf.current = setTimeout(flush, 50);
      },
      end: () => setEnded(true),
    },
  });

  // When streaming stops (deploy finished, stream ended, tail paused) catch up on anything the stream missed.
  const streaming = streamEnabled;
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming && key !== null) {
      optsRef.current
        .fetchPage({ limit: maxLines })
        .then((res) => {
          const items = [...res.items].sort((a, b) => a.id - b.id);
          if (items.length) lastIdRef.current = Math.max(lastIdRef.current ?? 0, items[items.length - 1].id);
          setLines((prev) => mergeAppend(prev, items, maxLines));
        })
        .catch(() => {});
    }
    wasStreaming.current = streaming;
  }, [streaming, key, maxLines]);

  const loadOlder = useCallback(async () => {
    const first = lines[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const res = await optsRef.current.fetchPage({ before: first.id, limit: pageSize });
      const older = [...res.items].filter((l) => l.id < first.id).sort((a, b) => a.id - b.id);
      setHasOlder(older.length >= pageSize);
      setLines((prev) => {
        const next = older.concat(prev);
        return next.length > maxLines ? next.slice(0, maxLines) : next;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [lines, pageSize, maxLines]);

  return {
    lines,
    state: ended ? 'closed' : state,
    loading,
    error,
    loadOlder,
    loadingOlder,
    hasOlder,
    ended,
    clear: () => setLines([]),
  };
}
