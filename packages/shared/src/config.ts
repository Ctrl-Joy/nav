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
  acmeDirectory: process.env.NAV_ACME_DIRECTORY ?? 'https://acme-staging-v02.api.letsencrypt.org/directory',
  acmeEmail: process.env.NAV_ACME_EMAIL ?? '',
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
};

export function publicUrlFor(slug: string): string {
  return `${config.publicScheme}://${slug}.${config.appsDomain}${config.publicPortSuffix}`;
}
