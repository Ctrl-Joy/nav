// Effective sign-in provider credentials: environment variables first, then what an instance administrator saved
// on the admin page (auth_provider_settings, secret encrypted with NAV_MASTER_KEY). Reads are synchronous against
// an in-memory copy; routes that use providers call ensureProviderSettings() first, which reloads it when stale.
import { config } from '@nav/shared/config';
import { decrypt, encrypt } from '@nav/shared/crypto';
import { one, q } from '../db/pool.ts';
import { resolveEffective, type ConfigurableProvider, type Credentials, type Effective } from './providerChecks.ts';

export interface SavedRow extends Credentials {
  updatedAt: string;
  updatedBy: string | null;
  /** The secret could not be decrypted (NAV_MASTER_KEY changed): treated as not configured. */
  unreadable: boolean;
}

/** Other control processes pick up a change within this long; this process sees its own saves immediately. */
const TTL_MS = 30_000;

let cache: { at: number; rows: Map<ConfigurableProvider, SavedRow> } | null = null;
let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  const rows = await q('SELECT s.*, u.email AS updated_by_email FROM auth_provider_settings s LEFT JOIN users u ON u.id = s.updated_by');
  const map = new Map<ConfigurableProvider, SavedRow>();
  for (const r of rows) {
    let secret = '';
    let unreadable = false;
    try {
      secret = decrypt(r.client_secret_enc);
    } catch {
      unreadable = true;
      console.error(`[auth] the saved ${r.provider} client secret can't be decrypted (was NAV_MASTER_KEY changed?); save it again on the admin page`);
    }
    map.set(r.provider, { clientId: r.client_id, clientSecret: secret, baseUrl: r.base_url, updatedAt: r.updated_at, updatedBy: r.updated_by_email ?? null, unreadable });
  }
  cache = { at: Date.now(), rows: map };
}

/** Loads saved provider settings if they are missing or stale. A database error keeps the previous copy. */
export async function ensureProviderSettings(): Promise<void> {
  if (cache && Date.now() - cache.at < TTL_MS) return;
  loading ??= load()
    .catch((err) => {
      console.error('[auth] could not load sign-in provider settings:', (err as Error).message);
      if (cache) cache.at = Date.now();
    })
    .finally(() => {
      loading = null;
    });
  await loading;
}

function envCredentials(p: ConfigurableProvider): Credentials {
  return p === 'github' ? { clientId: config.github.clientId, clientSecret: config.github.clientSecret } : { clientId: config.oauth[p].clientId, clientSecret: config.oauth[p].clientSecret };
}

export function savedProvider(p: ConfigurableProvider): SavedRow | null {
  return cache?.rows.get(p) ?? null;
}

export function effectiveProvider(p: ConfigurableProvider): Effective {
  const row = cache?.rows.get(p);
  return resolveEffective(p, envCredentials(p), row && !row.unreadable ? row : null, config.oauth.gitlab.baseUrl);
}

export async function saveProvider(p: ConfigurableProvider, creds: { clientId: string; clientSecret?: string; baseUrl?: string | null }, userId: string): Promise<void> {
  if (creds.clientSecret) {
    await q(
      `INSERT INTO auth_provider_settings (provider, client_id, client_secret_enc, base_url, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, base_url = EXCLUDED.base_url, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [p, creds.clientId, encrypt(creds.clientSecret), creds.baseUrl ?? null, userId],
    );
  } else {
    // Keep the stored secret; only the id (and base URL) change.
    await q('UPDATE auth_provider_settings SET client_id = $2, base_url = $3, updated_by = $4, updated_at = now() WHERE provider = $1', [p, creds.clientId, creds.baseUrl ?? null, userId]);
  }
  cache = null;
  await ensureProviderSettings();
}

export async function deleteProvider(p: ConfigurableProvider): Promise<boolean> {
  const res = await q('DELETE FROM auth_provider_settings WHERE provider = $1 RETURNING provider', [p]);
  cache = null;
  await ensureProviderSettings();
  return res.length > 0;
}

// ---- Instance administrators ----

/** Startup warning for production instances without NAV_ADMIN_EMAILS (they have no instance administrator). */
export function adminConfigWarning(): string | null {
  if (config.env !== 'production' || config.adminEmails.length) return null;
  return 'NAV_ADMIN_EMAILS is not set: this production instance has no instance administrator (sign-in providers and platform settings cannot be changed from the dashboard). Set it to the operators\' email addresses.';
}

/**
 * NAV instance administrators manage instance-wide settings such as sign-in providers. With NAV_ADMIN_EMAILS set,
 * they are the listed addresses, and only once the account has proved it owns the address (a provider vouched for
 * it, or a password reset link was used); otherwise anyone could sign up with an operator's email before they do.
 * Without the variable, outside production, the oldest account on the instance (normally whoever installed it) is
 * the administrator. In production that implicit rule is off: deleting the first account would silently hand the
 * instance to the next-oldest one, so production has no administrator until NAV_ADMIN_EMAILS names one.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  if (config.adminEmails.length) {
    const u = await one<{ email: string; email_verified_at: string | null }>('SELECT email, email_verified_at FROM users WHERE id = $1', [userId]);
    return !!u?.email_verified_at && config.adminEmails.includes(u.email.toLowerCase());
  }
  if (config.env === 'production') return false;
  const first = await one<{ id: string }>('SELECT id FROM users ORDER BY created_at, id LIMIT 1');
  return first?.id === userId;
}
