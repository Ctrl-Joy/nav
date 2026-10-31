import pg from 'pg';
import { config } from '@nav/shared/config';

// Return timestamps as ISO strings and bigints (counts, bigserial ids) as numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000 });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

export type Row = Record<string, any>;
export type Client = pg.PoolClient;

export async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type Channel = 'nav_logs' | 'nav_changes' | 'nav_routes';

export async function notify(channel: Channel, payload: string | object = ''): Promise<void> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await pool.query('SELECT pg_notify($1, $2)', [channel, text]);
}

/** Dedicated LISTEN connection with automatic reconnect. */
export function listen(channels: Channel[], onMessage: (channel: string, payload: string) => void): () => void {
  let client: pg.Client | null = null;
  let stopped = false;
  let delay = 500;
  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on('error', () => {});
    c.on('end', () => {
      client = null;
      if (!stopped) setTimeout(connect, (delay = Math.min(delay * 2, 10_000)));
    });
    c.on('notification', (n) => onMessage(n.channel, n.payload ?? ''));
    try {
      await c.connect();
      for (const ch of channels) await c.query(`LISTEN ${ch}`);
      client = c;
      delay = 500;
    } catch {
      c.end().catch(() => {});
    }
  };
  void connect();
  return () => {
    stopped = true;
    client?.end().catch(() => {});
  };
}
