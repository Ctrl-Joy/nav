// Process configuration shared by control, agent and edge. Everything comes from env vars.
import path from 'node:path';

function int(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : fallback;
}

const dataDir = path.resolve(process.env.NAV_DATA_DIR ?? '.nav');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.NAV_DATABASE_URL ?? 'postgres://nav:nav@127.0.0.1:5433/nav',
  dataDir,
  apiPort: int('NAV_API_PORT', 4000),
  dashboardUrl: process.env.NAV_DASHBOARD_URL ?? 'http://localhost:5180',
  apiPublicUrl: process.env.NAV_API_PUBLIC_URL ?? 'http://localhost:4000',
  appsDomain: process.env.NAV_APPS_DOMAIN ?? 'nav.localhost',
  edgeHttpPort: int('NAV_EDGE_HTTP_PORT', 7080),
  edgeHttpsPort: int('NAV_EDGE_HTTPS_PORT', 7443),
  edgePublicIp: process.env.NAV_EDGE_PUBLIC_IP ?? '127.0.0.1',
  /** Port appended to public URLs ('' in production when edge listens on 80/443). */
  publicPortSuffix: process.env.NAV_PUBLIC_PORT_SUFFIX ?? `:${int('NAV_EDGE_HTTP_PORT', 7080)}`,
  publicScheme: process.env.NAV_PUBLIC_SCHEME ?? 'http',
  driver: (process.env.NAV_DRIVER ?? 'auto') as 'auto' | 'docker' | 'process',
  /** Where agents and the edge reach the control plane's internal API (artifact store). */
  controlUrl: (process.env.NAV_CONTROL_URL ?? `http://127.0.0.1:${int('NAV_API_PORT', 4000)}`).replace(/\/+$/, ''),
  /** Address other nodes and the edge use to reach instances on this node (its private IP in a cluster). */
  nodeAddress: process.env.NAV_NODE_ADDRESS ?? '127.0.0.1',
  /** Interface instance ports are published on. Keep it private: the edge is the only public entry point. */
  nodeBindIp: process.env.NAV_NODE_BIND_IP ?? process.env.NAV_NODE_ADDRESS ?? '127.0.0.1',
  /** 'auto' uploads builds to the artifact store once the cluster has more than one node; 'always' / 'never'. */
  artifactUpload: (process.env.NAV_ARTIFACT_UPLOAD ?? 'auto') as 'auto' | 'always' | 'never',
  artifactMaxBytes: int('NAV_ARTIFACT_MAX_MB', 4096) * 1048576,
  acmeDirectory: process.env.NAV_ACME_DIRECTORY ?? 'https://acme-staging-v02.api.letsencrypt.org/directory',
  acmeEmail: process.env.NAV_ACME_EMAIL ?? '',
  /** Certificate for `*.<appsDomain>` + `<appsDomain>`: issued via ACME DNS-01 ('cloudflare') or supplied as files ('manual'). */
  platformTls: {
    dnsProvider: (process.env.NAV_DNS_PROVIDER ?? '').trim().toLowerCase(),
    cloudflareApiToken: process.env.NAV_CLOUDFLARE_API_TOKEN ?? '',
    certFile: process.env.NAV_WILDCARD_CERT_FILE ?? '',
    keyFile: process.env.NAV_WILDCARD_KEY_FILE ?? '',
    /** DNS-01 issuance runs in production when a provider is set; elsewhere only with NAV_PLATFORM_TLS=1. */
    enabled: (process.env.NAV_PLATFORM_TLS ?? (process.env.NODE_ENV === 'production' ? '1' : '0')) === '1',
  },
  /** Comma-separated emails of platform administrators. Unset: the first user who signed up. */
  adminEmails: (process.env.NAV_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  github: {
    clientId: process.env.NAV_GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.NAV_GITHUB_CLIENT_SECRET ?? '',
    appId: process.env.NAV_GITHUB_APP_ID ?? '',
    appSlug: process.env.NAV_GITHUB_APP_SLUG ?? '',
    privateKey: (process.env.NAV_GITHUB_APP_PRIVATE_KEY ?? '').replace(/\n/g, '\n'),
    webhookSecret: process.env.NAV_GITHUB_WEBHOOK_SECRET ?? '',
  },
  /** Extra sign-in providers. Each is enabled when its client id and secret are set. */
  oauth: {
    gitlab: {
      clientId: process.env.NAV_GITLAB_CLIENT_ID ?? '',
      clientSecret: process.env.NAV_GITLAB_CLIENT_SECRET ?? '',
      baseUrl: (process.env.NAV_GITLAB_URL ?? 'https://gitlab.com').replace(/\/+$/, ''),
    },
    bitbucket: {
      clientId: process.env.NAV_BITBUCKET_CLIENT_ID ?? '',
      clientSecret: process.env.NAV_BITBUCKET_CLIENT_SECRET ?? '',
    },
    google: {
      clientId: process.env.NAV_GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.NAV_GOOGLE_CLIENT_SECRET ?? '',
    },
  },
  /** OpenID Connect single sign-on for the listed email domains. */
  sso: {
    issuer: (process.env.NAV_SSO_ISSUER ?? '').replace(/\/+$/, ''),
    clientId: process.env.NAV_SSO_CLIENT_ID ?? '',
    clientSecret: process.env.NAV_SSO_CLIENT_SECRET ?? '',
    domains: (process.env.NAV_SSO_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  },
  logRetentionDays: int('NAV_LOG_RETENTION_DAYS', 7),
  /** Free web services spin down after this many minutes without inbound traffic; 0 disables sleeping. */
  freeSleepMinutes: int('NAV_FREE_SLEEP_MINUTES', 15),
  /** Outgoing mail, e.g. smtps://user:pass@smtp.example.com:465. Unset: messages are written to <dataDir>/outbox. */
  smtpUrl: process.env.NAV_SMTP_URL ?? '',
  mailFrom: process.env.NAV_MAIL_FROM ?? 'NAV <no-reply@nav.localhost>',
  /** Webhooks and log streams may target private addresses (development). Off in production. */
  allowPrivateTargets: (process.env.NAV_ALLOW_PRIVATE_TARGETS ?? (process.env.NODE_ENV === 'production' ? '0' : '1')) === '1',
};

export function publicUrlFor(slug: string): string {
  return `${config.publicScheme}://${slug}.${config.appsDomain}${config.publicPortSuffix}`;
}
