// Server-Sent Events hub: one LISTEN connection fans out log lines and change notifications to subscribers.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { listen } from '../db/pool.ts';

type LogNote = { id: number; serviceId: string | null; databaseId: string | null; deployId: string | null; runId: string | null };
type ChangeNote = { workspaceId: string; entity: string; id: string; serviceId: string | null };

const logSubs = new Set<(n: LogNote) => void>();
const changeSubs = new Set<(n: ChangeNote) => void>();
let started = false;

function ensureListener() {
  if (started) return;
  started = true;
  listen(['nav_logs', 'nav_changes'], (channel, payload) => {
    try {
      const note = JSON.parse(payload);
      if (channel === 'nav_logs') for (const s of logSubs) s(note);
      else for (const s of changeSubs) s(note);
    } catch {
      /* ignore malformed */
    }
  });
}

export function onLog(fn: (n: LogNote) => void): () => void {
  ensureListener();
  logSubs.add(fn);
  return () => logSubs.delete(fn);
}

export function onChange(fn: (n: ChangeNote) => void): () => void {
  ensureListener();
  changeSubs.add(fn);
  return () => changeSubs.delete(fn);
}

export interface SseStream {
  send(event: string, data: unknown, id?: string | number): void;
  closed: boolean;
  onClose(fn: () => void): void;
  end(): void;
}

export function openSse(req: FastifyRequest, reply: FastifyReply): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const closers: (() => void)[] = [];
  const stream: SseStream = {
    closed: false,
    send(event, data, id) {
      if (stream.closed) return;
      res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn) {
      closers.push(fn);
    },
    end() {
      if (stream.closed) return;
      stream.closed = true;
      clearInterval(ping);
      for (const c of closers) c();
      res.end();
    },
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.raw.on('close', () => stream.end());
  return stream;
}
