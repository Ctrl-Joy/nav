// NAV edge: public ingress, reverse proxy, load balancer, TLS terminator and static file server.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import pg from 'pg';
import { config } from '@nav/shared/config';
import { decrypt } from '@nav/shared/crypto';
import { DbRouteWatcher, RouteTable, routeLoader } from './routes.ts';
import { CertStore, certLoader, ensureDevCerts, platformCertMonitor, wildcardFileLoader } from './tls.ts';
import { Metrics } from './metrics.ts';
import { Edge } from './proxy.ts';

const log = (m: string) => console.error(m);
const production = config.env === 'production';

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
pool.on('error', (err) => log(`[edge] pg pool error: ${err.message}`));

const table = new RouteTable(config.appsDomain);
const dev = ensureDevCerts(config.dataDir, config.appsDomain);
const certs = new CertStore({ cert: dev.cert, key: dev.key }, decrypt, log, { appsDomain: config.appsDomain });
const { certFile, keyFile } = config.platformTls;
const metrics = new Metrics(pool, log);

/** NAV_DASHBOARD_HOST: the edge serves the control plane (dashboard + API) there, reaching it at NAV_CONTROL_URL. */
function controlPlaneRoute() {
  if (!config.dashboardHost) return null;
  const u = new URL(config.controlUrl);
  const target = { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  const apex = config.dashboardHost.endsWith(`.${config.appsDomain}`) ? config.appsDomain : undefined;
  return { host: config.dashboardHost, target, apexRedirect: apex };
}

const edge = new Edge({
  table,
  production,
  metrics,
  accessLog: process.env.NAV_EDGE_ACCESS_LOG === '1',
  forceHttps: process.env.NAV_EDGE_FORCE_HTTPS === '1',
  httpsPort: config.edgeHttpsPort,
  controlPlane: controlPlaneRoute(),
  hasCert: (host) => certs.hasCert(host),
  acmeLookup: async (token) => {
    const { rows } = await pool.query<{ key_auth: string }>('SELECT key_auth FROM acme_challenges WHERE token = $1', [token]);
    return rows[0]?.key_auth ?? null;
  },
  // Any control replica LISTENing on nav_wake picks this up; waking an awake service is a no-op.
  wake: async (serviceId) => { await pool.query("SELECT pg_notify('nav_wake', $1)", [serviceId]); },
  log,
});

const watcher = new DbRouteWatcher({
  pool,
  createListener: () => new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5_000, keepAlive: true }),
  loaders: [
    routeLoader(pool, table),
    certLoader(pool, certs),
    // Manual platform wildcard: re-stat'ed on every poll, reloaded when the files change.
    ...(certFile && keyFile ? [wildcardFileLoader(certs, certFile, keyFile, log)] : []),
    platformCertMonitor(certs, config.appsDomain, production, log),
  ],
  log,
});

const httpServer = http.createServer();
const httpsServer = https.createServer({
  cert: dev.cert,
  key: dev.key,
  SNICallback: certs.sniCallback,
  minVersion: 'TLSv1.2',
  ALPNProtocols: ['http/1.1'],
});
edge.attach(httpServer, false);
edge.attach(httpsServer, true);

function listen(server: http.Server | https.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { server.off('error', reject); resolve(); });
  });
}

async function main(): Promise<void> {
  await watcher.start(); // first load failure is tolerated: we serve 404s until the DB is reachable
  metrics.start(10_000);
  await listen(httpServer, config.edgeHttpPort);
  await listen(httpsServer, config.edgeHttpsPort);
  log(`[edge] ${os.hostname()} listening http :${config.edgeHttpPort} https :${config.edgeHttpsPort} (apps domain ${config.appsDomain}, ${table.size} routes, ${certs.size} certs${config.dashboardHost ? `, dashboard ${config.dashboardHost} → ${config.controlUrl}` : ''})`);
  if (!certs.platformSource()) log(`[edge] local dev CA${dev.generated ? ' (generated)' : ''}: ${dev.caPath} — trust it to avoid TLS warnings for *.${config.appsDomain}`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[edge] ${signal} received, draining (max 10s)`);
  const closed = Promise.all([httpServer, httpsServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
  httpServer.closeIdleConnections();
  httpsServer.closeIdleConnections();
  const force = setTimeout(() => {
    httpServer.closeAllConnections();
    httpsServer.closeAllConnections();
    edge.closeAll();
  }, 10_000);
  force.unref();
  await Promise.race([closed, new Promise((r) => setTimeout(r, 10_500))]);
  edge.closeAll();
  await watcher.stop();
  await metrics.stop().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  log(`[edge] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
