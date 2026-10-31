import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';

export const DEFAULT_HOST = 'http://localhost:4000';

export interface StoredConfig {
  host?: string;
  token?: string;
  workspaceId?: string;
}

export interface ResolvedConfig {
  host: string;
  token: string | null;
  workspaceId: string | null;
  tokenFromEnv: boolean;
  workspaceFromEnv: boolean;
}

export function configPath(): string {
  return join(homedir(), '.nav', 'config.json');
}

// Accepts "localhost:4000", "http://host", "https://host/" or "https://host/api/v1" and returns
// the origin plus any path prefix, without a trailing slash or /api/v1 suffix.
export function normalizeHost(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CliError('host must not be empty');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(`invalid host: ${input}`, 'expected something like http://localhost:4000');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export async function readStoredConfig(): Promise<StoredConfig> {
  const file = configPath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${file} is not valid JSON`, 'fix or delete the file, then run nav login');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${file} must contain a JSON object`, 'fix or delete the file, then run nav login');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    host: stringField(obj, 'host'),
    token: stringField(obj, 'token'),
    workspaceId: stringField(obj, 'workspaceId'),
  };
}

// Writes the whole config file. Empty or undefined fields are omitted.
export async function writeStoredConfig(config: StoredConfig): Promise<void> {
  const file = configPath();
  const clean: StoredConfig = {};
  if (config.host) clean.host = config.host;
  if (config.token) clean.token = config.token;
  if (config.workspaceId) clean.workspaceId = config.workspaceId;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

export async function updateStoredConfig(patch: StoredConfig): Promise<void> {
  const current = await readStoredConfig();
  await writeStoredConfig({ ...current, ...patch });
}

// Environment variables override the file: NAV_HOST, NAV_TOKEN, NAV_WORKSPACE.
export async function resolveConfig(): Promise<ResolvedConfig> {
  const stored = await readStoredConfig();
  const envHost = process.env.NAV_HOST?.trim() || null;
  const envToken = process.env.NAV_TOKEN?.trim() || null;
  const envWorkspace = process.env.NAV_WORKSPACE?.trim() || null;
  return {
    host: normalizeHost(envHost ?? stored.host ?? DEFAULT_HOST),
    token: envToken ?? stored.token ?? null,
    workspaceId: envWorkspace ?? stored.workspaceId ?? null,
    tokenFromEnv: envToken !== null,
    workspaceFromEnv: envWorkspace !== null,
  };
}
