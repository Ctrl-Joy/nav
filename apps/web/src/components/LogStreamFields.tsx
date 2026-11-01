import type { LogStream, LogStreamInput, LogStreamProtocol } from '@/api/types';
import { Checkbox, Field, Input, Select, Switch } from '@/components/ui';

export const LOG_STREAM_PROTOCOLS: { value: LogStreamProtocol; label: string }[] = [
  { value: 'syslog-tls', label: 'Syslog over TLS' },
  { value: 'syslog-tcp', label: 'Syslog over TCP' },
  { value: 'https', label: 'HTTPS (JSON lines)' },
];

export interface LogStreamDraft {
  protocol: LogStreamProtocol;
  endpoint: string;
  /** New token; empty keeps the stored one. */
  token: string;
  clearToken: boolean;
  enabled: boolean;
}

export function logStreamDraft(s: LogStream | null | undefined): LogStreamDraft {
  return { protocol: s?.protocol ?? 'syslog-tls', endpoint: s?.endpoint ?? '', token: '', clearToken: false, enabled: s?.enabled ?? true };
}

export function logStreamInput(d: LogStreamDraft): LogStreamInput {
  return { protocol: d.protocol, endpoint: d.endpoint.trim(), token: d.token ? d.token : d.clearToken ? null : undefined, enabled: d.enabled };
}

export function logStreamEndpointError(d: LogStreamDraft): string | null {
  const v = d.endpoint.trim();
  if (!v) return null;
  if (d.protocol === 'https') return /^https:\/\/\S+$/.test(v) ? null : 'Enter an https:// URL.';
  return /^\[?[^\]\s/]+\]?:\d{1,5}$/.test(v) ? null : 'Enter host:port, e.g. logs.example.com:6514.';
}

export function logStreamDirty(d: LogStreamDraft, s: LogStream | null | undefined): boolean {
  const base = logStreamDraft(s);
  return d.protocol !== base.protocol || d.endpoint.trim() !== base.endpoint || d.enabled !== base.enabled || !!d.token || d.clearToken;
}

/** Destination, protocol, token and on/off for a log stream (workspace default or per-service override). */
export function LogStreamFields({
  draft,
  onChange,
  hasToken,
  disabled,
}: {
  draft: LogStreamDraft;
  onChange: (d: LogStreamDraft) => void;
  hasToken: boolean;
  disabled?: boolean;
}) {
  const set = (patch: Partial<LogStreamDraft>) => onChange({ ...draft, ...patch });
  const err = logStreamEndpointError(draft);
  return (
    <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
      <Field label="Protocol">
        {(id) => <Select id={id} value={draft.protocol} onChange={(e) => set({ protocol: e.target.value as LogStreamProtocol })} options={LOG_STREAM_PROTOCOLS} disabled={disabled} />}
      </Field>
      <Field label="Endpoint" error={err} hint={draft.protocol === 'https' ? 'NAV POSTs batches of newline-delimited JSON.' : 'RFC 5424 syslog, one line per log entry.'}>
        {(id) => (
          <Input
            id={id}
            mono
            value={draft.endpoint}
            onChange={(e) => set({ endpoint: e.target.value })}
            placeholder={draft.protocol === 'https' ? 'https://logs.example.com/ingest' : 'logs.example.com:6514'}
            aria-invalid={!!err}
            disabled={disabled}
          />
        )}
      </Field>
      <Field
        label="Token"
        optional
        className="sm:col-span-2"
        hint={draft.protocol === 'https' ? 'Sent as a Bearer token.' : 'Sent in each line\'s structured data (e.g. a Better Stack source token).'}
      >
        {(id) => (
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id={id}
              mono
              type="password"
              className="min-w-0 flex-1"
              value={draft.token}
              onChange={(e) => set({ token: e.target.value, clearToken: false })}
              placeholder={hasToken && !draft.clearToken ? '•••••••• (saved — leave empty to keep)' : 'No token'}
              autoComplete="off"
              disabled={disabled}
            />
            {hasToken && <Checkbox checked={draft.clearToken} onChange={(v) => set({ clearToken: v, token: '' })} label="Remove saved token" disabled={disabled} />}
          </div>
        )}
      </Field>
      <div className="sm:col-span-2">
        <Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} disabled={disabled} label={draft.enabled ? 'Streaming' : 'Paused'} />
      </div>
    </div>
  );
}
