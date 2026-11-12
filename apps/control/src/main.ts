// NAV control plane: REST API + scheduler loops.
import { config } from '@nav/shared/config';
import { migrate } from './db/migrate.ts';
import { pool } from './db/pool.ts';
import { buildApp } from './http/app.ts';
import { startScheduler } from './scheduler/index.ts';
import { startControlJobs } from './scheduler/jobs.ts';
import { ensurePlatformCertificate } from './lib/platformTls.ts';
import { adminConfigWarning } from './lib/providerSettings.ts';
import { startLogStreams, startMetricsStreams } from './scheduler/streams.ts';
import { startNotifier } from './scheduler/notifier.ts';
import { startWakeListener } from './lib/sleep.ts';

if (!process.env.NAV_MASTER_KEY) {
  console.error('NAV_MASTER_KEY must be set (64 hex chars). Use `npm run dev` for local development.');
  process.exit(1);
}

const adminWarning = adminConfigWarning();
if (adminWarning) console.warn(`[control] WARNING: ${adminWarning}`);

await migrate();
const app = await buildApp();
await app.listen({ port: config.apiPort, host: process.env.NAV_API_HOST ?? '127.0.0.1' });
console.log(`[control] API listening on http://localhost:${config.apiPort}/api/v1`);
startScheduler();
startNotifier();
startControlJobs();
void ensurePlatformCertificate().catch((err) => console.error('[tls] wildcard certificate:', (err as Error).message));
startLogStreams();
startMetricsStreams();
startWakeListener();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  // Fastify's close() waits for every open connection, and live dashboard streams (SSE) never end on their own, which kept
  // the process alive until systemd killed it 90 seconds later. Drop the connections, and bound the whole shutdown.
  setTimeout(() => process.exit(0), 8_000).unref();
  const closing = app.close().catch(() => {});
  app.server.closeAllConnections?.();
  await closing;
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
