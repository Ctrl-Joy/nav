// Admin-only workspace settings sections: login policy, webhooks, log & metrics streams, registry credentials.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Pencil, Plus, RotateCcw, RotateCw, Send, Trash2 } from 'lucide-react';
import { useUpdateWorkspace } from '@/api/workspaces';
import { errorMessage, isApiError } from '@/api/client';
import {
  useCreateRegistryCredential,
  useCreateWebhook,
  useDeleteLogStream,
  useDeleteMetricsStream,
  useDeleteRegistryCredential,
  useDeleteWebhook,
  useLogStreams,
  useMetricsStream,
  useRegistryCredentials,
  useRetryDelivery,
  useRotateWebhookSecret,
  useSaveLogStream,
  useSaveMetricsStream,
  useTestMetricsStream,
  useTestWebhook,
  useUpdateRegistryCredential,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhookEvents,
  useWebhooks,
  useWebhookSecret,
  type RegistryCredentialInput,
  type WebhookInput,
} from '@/api/integrations';
import { useServices } from '@/api/services';
import type { LogStream, OutboundWebhook, RegistryCredential, WebhookDelivery } from '@/api/types';
import { LogStreamFields, logStreamDirty, logStreamDraft, logStreamEndpointError, logStreamInput } from '@/components/LogStreamFields';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  CopyField,
  Dialog,
  Empty,
  ErrorState,
  Field,
  IconButton,
  Input,
  SecretValue,
  SkeletonRows,
  StatusPill,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatDateTime } from '@/lib/time';
import { Row, Section } from './parts';

/** "last sent 3m ago" / last error, shared by the stream sections. */
function StreamStatus({ lastSentAt, lastError, enabled }: { lastSentAt: string | null; lastError: string | null; enabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
      <StatusPill status={!enabled ? 'suspended' : lastError ? 'error' : lastSentAt ? 'live' : 'pending'} label={!enabled ? 'Paused' : lastError ? 'Failing' : lastSentAt ? 'Delivering' : 'Waiting for data'} />
      {lastSentAt && (
        <span>
          Last sent <RelativeTime value={lastSentAt} />
        </span>
      )}
      {lastError && <span className="w-full font-mono text-xs break-all text-danger">{lastError}</span>}
    </div>
  );
}

// Login settings ---------------------------------------------------------------------------------

export function LoginSettingsSection() {
  const { ws, workspace, user } = useWorkspace();
  const update = useUpdateWorkspace(ws);
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const on = !!workspace.requireTwoFactor;

  const toggle = async (v: boolean) => {
    setError(null);
    try {
      await update.mutateAsync({ requireTwoFactor: v });
      toast.success(v ? 'Two-factor authentication required' : 'Two-factor authentication optional');
    } catch (err) {
      if (isApiError(err) && err.code === 'mfa_required') setError('Turn on two-factor authentication for your own account first, so you are not locked out.');
      else toast.fromError(err, 'Could not update login settings');
    }
  };

  return (
    <Section id="login" title="Login Settings">
      <Row
        label="Require two-factor authentication"
        description="Members without 2FA keep their membership but can't view or change anything in this workspace until they turn it on."
      >
        <Switch checked={on} onChange={toggle} disabled={update.isPending} label={on ? 'Required' : 'Optional'} />
        {!user.mfaEnabled && !on && (
          <p className="mt-2 text-[13px] text-fg-muted">
            You haven't turned on 2FA yet.{' '}
            <Link to={`/w/${ws}/account#security`} className="text-accent hover:underline">
              Set it up
            </Link>{' '}
            before requiring it.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {error}{' '}
            <Link to={`/w/${ws}/account#security`} className="font-medium underline">
              Account settings
            </Link>
          </p>
        )}
      </Row>
    </Section>
  );
}

// Webhooks ---------------------------------------------------------------------------------------

const BLANK_HOOK: WebhookInput = { name: '', url: '', events: [], enabled: true };

function WebhookForm({ initial, onSubmit, pending, formId }: { initial: WebhookInput; onSubmit: (v: WebhookInput) => void; pending: boolean; formId: string }) {
  const events = useWebhookEvents();
  const [v, setV] = useState(initial);
  const urlErr = v.url && !/^https?:\/\/\S+$/.test(v.url) ? 'Enter an http(s) URL.' : null;
  const all = v.events.length === 0;
  const toggleEvent = (e: string, on: boolean) => setV({ ...v, events: on ? [...v.events, e] : v.events.filter((x) => x !== e) });
  return (
    <form
      id={formId}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && v.name.trim() && v.url.trim() && !urlErr) onSubmit({ ...v, name: v.name.trim(), url: v.url.trim() });
      }}
    >
      <Field label="Name">{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Deploy alerts" autoFocus />}</Field>
      <Field label="Payload URL" error={urlErr} hint="NAV sends a POST with a JSON body for each event.">
        {(id) => <Input id={id} mono value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} placeholder="https://example.com/webhooks/nav" aria-invalid={!!urlErr} />}
      </Field>
      <div>
        <p className="mb-2 text-[13px] font-medium text-fg">Events</p>
        <Checkbox checked={all} onChange={(on) => setV({ ...v, events: on ? [] : (events.data?.items.slice(0, 1) ?? []) })} label="All events (including ones added later)" />
        {!all && (
          <div className="mt-3 grid max-h-56 gap-1.5 overflow-y-auto rounded-[3px] border border-border p-3 sm:grid-cols-2">
            {(events.data?.items ?? []).map((e) => (
              <Checkbox key={e} checked={v.events.includes(e)} onChange={(on) => toggleEvent(e, on)} label={<span className="font-mono text-xs">{e}</span>} />
            ))}
          </div>
        )}
      </div>
      <Switch checked={v.enabled} onChange={(on) => setV({ ...v, enabled: on })} label={v.enabled ? 'Active' : 'Disabled'} description="Disabled webhooks receive nothing." />
    </form>
  );
}

function SigningSecretNote() {
  return (
    <p className="text-[13px] text-fg-muted">
      Signatures follow the{' '}
      <a href="https://www.standardwebhooks.com/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
        Standard Webhooks
      </a>{' '}
      spec: verify the <code className="font-mono text-xs">webhook-signature</code> header (HMAC-SHA256 of{' '}
      <code className="font-mono text-xs">{'{webhook-id}.{webhook-timestamp}.{body}'}</code>) with this secret, and reject stale{' '}
      <code className="font-mono text-xs">webhook-timestamp</code> values.
    </p>
  );
}

function DeliveryRow({ d, onRetry, retrying }: { d: WebhookDelivery; onRetry: () => void; retrying: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tr interactive onClick={() => setOpen((o) => !o)}>
        <Td>
          <StatusPill status={d.status} />
        </Td>
        <Td className="font-mono text-xs">{d.eventType}</Td>
        <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">{d.statusCode ?? '—'}</Td>
        <Td className="hidden text-fg-muted md:table-cell">{d.attempts}</Td>
        <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{d.durationMs != null ? `${d.durationMs} ms` : '—'}</Td>
        <Td className="text-fg-muted">
          <span title={formatDateTime(d.createdAt)}>
            <RelativeTime value={d.createdAt} />
          </span>
        </Td>
        <Td className="text-right">
          {d.status === 'failed' && (
            <Button
              size="xs"
              icon={<RotateCcw className="size-3" />}
              disabled={retrying}
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              Retry
            </Button>
          )}
        </Td>
      </Tr>
      {open && (
        <tr>
          <td colSpan={7} className="px-4 pb-4">
            {d.error && <p className="mb-2 font-mono text-xs break-all text-danger">{d.error}</p>}
            {d.nextAttemptAt && (
              <p className="mb-2 text-xs text-fg-muted">
                Next attempt <RelativeTime value={d.nextAttemptAt} />
              </p>
            )}
            <CodeBlock code={JSON.stringify(d.payload, null, 2)} title="Payload" />
          </td>
        </tr>
      )}
    </>
  );
}

/** Secret, test button and recent deliveries of one webhook. */
function WebhookDetail({ hook, onClose }: { hook: OutboundWebhook; onClose: () => void }) {
  const [reveal, setReveal] = useState(false);
  const secret = useWebhookSecret(hook.id, reveal);
  const rotate = useRotateWebhookSecret(hook.id);
  const test = useTestWebhook(hook.id);
  const deliveries = useWebhookDeliveries(hook.id);
  const retry = useRetryDelivery(hook.id);
  const confirm = useConfirm();
  const toast = useToast();

  const onRotate = async () => {
    const ok = await confirm({ title: 'Rotate signing secret?', body: 'The current secret stops working immediately. Update your receiver right after.', confirmText: 'Rotate', danger: true });
    if (!ok) return;
    try {
      await rotate.mutateAsync();
      setReveal(true);
      toast.success('Signing secret rotated');
    } catch (e) {
      toast.fromError(e, 'Could not rotate secret');
    }
  };
  const onTest = async () => {
    try {
      const { delivery } = await test.mutateAsync();
      if (delivery.status === 'succeeded') toast.success('Test event delivered', `HTTP ${delivery.statusCode ?? ''} in ${delivery.durationMs ?? '?'} ms`);
      else toast.error('Test event failed', delivery.error ?? (delivery.statusCode ? `HTTP ${delivery.statusCode}` : undefined));
    } catch (e) {
      toast.fromError(e, 'Could not send test event');
    }
  };

  return (
    <Dialog open onClose={onClose} title={hook.name} description={<span className="font-mono break-all">{hook.url}</span>} size="xl">
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-fg">Signing secret</p>
          <div className="flex flex-wrap items-center gap-2">
            {reveal && secret.data ? (
              <SecretValue value={secret.data.secret} className="min-w-0 flex-1" />
            ) : (
              <Button size="sm" icon={<Eye className="size-3.5" />} loading={reveal && secret.isFetching} onClick={() => setReveal(true)}>
                Reveal secret
              </Button>
            )}
            <Button size="sm" icon={<RotateCw className="size-3.5" />} loading={rotate.isPending} onClick={onRotate}>
              Rotate
            </Button>
          </div>
          {secret.isError && <p className="text-xs text-danger">{errorMessage(secret.error)}</p>}
          <SigningSecretNote />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-fg">Recent deliveries</p>
            <Button size="sm" icon={<Send className="size-3.5" />} loading={test.isPending} onClick={onTest}>
              Send test event
            </Button>
          </div>
          {deliveries.isPending ? (
            <SkeletonRows rows={3} />
          ) : deliveries.isError ? (
            <ErrorState error={deliveries.error} onRetry={() => deliveries.refetch()} />
          ) : !deliveries.data.items.length ? (
            <Empty compact title="No deliveries yet" description="Deliveries appear here when a subscribed event happens, or when you send a test event." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Status</Th>
                  <Th>Event</Th>
                  <Th className="hidden sm:table-cell">Response</Th>
                  <Th className="hidden md:table-cell">Attempts</Th>
                  <Th className="hidden md:table-cell">Duration</Th>
                  <Th>Created</Th>
                  <Th className="w-20">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {deliveries.data.items.map((d) => (
                  <DeliveryRow
                    key={d.id}
                    d={d}
                    retrying={retry.isPending}
                    onRetry={() => retry.mutate(d.id, { onSuccess: () => toast.success('Delivery queued for retry'), onError: (e) => toast.fromError(e, 'Could not retry delivery') })}
                  />
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function WebhooksSection() {
  const { ws } = useWorkspace();
  const hooks = useWebhooks(ws);
  const create = useCreateWebhook(ws);
  const update = useUpdateWebhook(ws);
  const del = useDeleteWebhook(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<OutboundWebhook | 'new' | null>(null);
  const [detail, setDetail] = useState<OutboundWebhook | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  const submit = async (v: WebhookInput) => {
    try {
      if (editing === 'new') {
        const res = await create.mutateAsync(v);
        setCreated({ name: res.webhook.name, secret: res.secret });
      } else if (editing) {
        await update.mutateAsync({ id: editing.id, ...v });
        toast.success('Webhook updated');
      }
      setEditing(null);
    } catch (err) {
      toast.fromError(err, 'Could not save webhook');
    }
  };

  const remove = async (h: OutboundWebhook) => {
    if (!(await confirm({ title: `Delete ${h.name}?`, body: 'NAV stops sending events to this URL. Its delivery history is deleted.', confirmText: 'Delete', danger: true }))) return;
    del.mutate(h.id, { onSuccess: () => toast.success('Webhook deleted'), onError: (e) => toast.fromError(e, 'Could not delete webhook') });
  };

  return (
    <Section id="webhooks" title="Webhooks" description="Send signed JSON to your own endpoints when deploys, services, databases and members change. Failed deliveries are retried with backoff.">
      <div className="mb-4 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          Add webhook
        </Button>
      </div>
      {hooks.isPending ? (
        <SkeletonRows rows={2} />
      ) : hooks.isError ? (
        <ErrorState error={hooks.error} onRetry={() => hooks.refetch()} />
      ) : !hooks.data.items.length ? (
        <Empty compact title="No webhooks" description="Add one to get notified about events in this workspace." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Webhook</Th>
              <Th className="hidden sm:table-cell">Events</Th>
              <Th>Active</Th>
              <Th className="w-28">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {hooks.data.items.map((h) => (
              <Tr key={h.id} interactive onClick={() => setDetail(h)}>
                <Td>
                  <div className="font-medium">{h.name}</div>
                  <div className="max-w-[40ch] truncate font-mono text-[11px] text-fg-subtle">{h.url}</div>
                </Td>
                <Td className="hidden text-fg-muted sm:table-cell">{h.events.length ? `${h.events.length} selected` : 'All events'}</Td>
                <Td onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={h.enabled}
                    disabled={update.isPending}
                    onChange={(v) => update.mutate({ id: h.id, enabled: v }, { onError: (e) => toast.fromError(e, 'Could not update webhook') })}
                  />
                </Td>
                <Td onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <IconButton label={`Edit ${h.name}`} icon={<Pencil className="size-3.5" />} onClick={() => setEditing(h)} />
                    <IconButton label={`Delete ${h.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => remove(h)} />
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add webhook' : 'Edit webhook'}
        size="lg"
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="webhook-form" loading={create.isPending || update.isPending}>
              {editing === 'new' ? 'Add webhook' : 'Save changes'}
            </Button>
          </>
        }
      >
        {editing && (
          <WebhookForm
            key={editing === 'new' ? 'new' : editing.id}
            formId="webhook-form"
            initial={editing === 'new' ? BLANK_HOOK : { name: editing.name, url: editing.url, events: editing.events, enabled: editing.enabled }}
            pending={create.isPending || update.isPending}
            onSubmit={submit}
          />
        )}
      </Dialog>

      <Dialog
        open={!!created}
        onClose={() => setCreated(null)}
        title="Webhook created"
        description={created?.name}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        {created && (
          <div className="space-y-3">
            <p className="text-[13px] text-fg">Copy the signing secret now. You can reveal or rotate it later from the webhook's details.</p>
            <CopyField value={created.secret} />
            <SigningSecretNote />
          </div>
        )}
      </Dialog>

      {detail && <WebhookDetail hook={detail} onClose={() => setDetail(null)} />}
    </Section>
  );
}

// Log streams ------------------------------------------------------------------------------------

function DefaultLogStreamForm({ stream }: { stream: LogStream | null }) {
  const { ws } = useWorkspace();
  const save = useSaveLogStream(ws);
  const del = useDeleteLogStream(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const [draft, setDraft] = useState(() => logStreamDraft(stream));
  useEffect(() => setDraft(logStreamDraft(stream)), [stream]);
  const dirty = logStreamDirty(draft, stream);
  const invalid = !draft.endpoint.trim() || !!logStreamEndpointError(draft);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    try {
      await save.mutateAsync(logStreamInput(draft));
      toast.success('Log stream saved');
    } catch (err) {
      toast.fromError(err, 'Could not save log stream');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Remove the default log stream?', body: 'Services without their own stream stop forwarding logs.', confirmText: 'Remove', danger: true }))) return;
    del.mutate(undefined, { onSuccess: () => toast.success('Log stream removed'), onError: (err) => toast.fromError(err, 'Could not remove log stream') });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {stream && <StreamStatus lastSentAt={stream.lastSentAt} lastError={stream.lastError} enabled={stream.enabled} />}
      <LogStreamFields draft={draft} onChange={setDraft} hasToken={!!stream?.hasToken} />
      <div className="flex flex-wrap justify-end gap-2">
        {stream && (
          <Button variant="outline-danger" size="sm" loading={del.isPending} onClick={remove}>
            Remove
          </Button>
        )}
        {dirty && stream && (
          <Button size="sm" onClick={() => setDraft(logStreamDraft(stream))}>
            Discard
          </Button>
        )}
        <Button size="sm" variant="primary" type="submit" loading={save.isPending} disabled={!dirty || invalid}>
          {stream ? 'Save changes' : 'Start streaming'}
        </Button>
      </div>
    </form>
  );
}

export function LogStreamsSection() {
  const { ws } = useWorkspace();
  const streams = useLogStreams(ws);
  const services = useServices(ws, { includePreviews: true });
  const names = useMemo(() => new Map((services.data?.items ?? []).map((s) => [s.id, s.name])), [services.data]);
  return (
    <Section id="log-streams" title="Log Streams" description="Forward runtime logs from every service to a syslog or HTTPS endpoint (Better Stack, Datadog, Papertrail, your own collector).">
      {streams.isPending ? (
        <SkeletonRows rows={3} />
      ) : streams.isError ? (
        <ErrorState error={streams.error} onRetry={() => streams.refetch()} />
      ) : (
        <>
          <Row label="Default destination" description="Used by every service unless it has its own stream or has opted out.">
            <DefaultLogStreamForm stream={streams.data.default} />
          </Row>
          <Row label="Service overrides" description="Set or opt out per service under the service's Settings tab.">
            {!streams.data.overrides.length ? (
              <p className="text-[13px] text-fg-muted">No service overrides.</p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {streams.data.overrides.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                    <Link to={`/w/${ws}/services/${o.serviceId}/settings#log-stream`} className="font-medium text-fg hover:underline">
                      {(o.serviceId && names.get(o.serviceId)) ?? o.serviceId}
                    </Link>
                    {o.enabled ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{o.endpoint}</span> : <span className="flex-1 text-fg-muted">Opted out</span>}
                    {o.lastError && <Badge tone="danger">Failing</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </>
      )}
    </Section>
  );
}

// Metrics stream ---------------------------------------------------------------------------------

export function MetricsStreamSection() {
  const { ws } = useWorkspace();
  const ms = useMetricsStream(ws);
  const save = useSaveMetricsStream(ws);
  const del = useDeleteMetricsStream(ws);
  const test = useTestMetricsStream(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const stream = ms.data?.stream ?? null;
  const [endpoint, setEndpoint] = useState('');
  const [enabled, setEnabled] = useState(true);
  // null = keep the saved headers; an array replaces them all.
  const [headers, setHeaders] = useState<{ name: string; value: string }[] | null>(null);
  const reset = () => {
    setEndpoint(stream?.endpoint ?? '');
    setEnabled(stream?.enabled ?? true);
    setHeaders(null);
  };
  useEffect(reset, [stream]); // eslint-disable-line react-hooks/exhaustive-deps

  const urlErr = endpoint && !/^https?:\/\/\S+$/.test(endpoint.trim()) ? 'Enter an http(s) URL.' : null;
  const headerErr = headers?.some((h) => h.name && !/^[A-Za-z0-9-]+$/.test(h.name)) ? 'Header names may contain letters, digits and dashes.' : null;
  const dirty = endpoint.trim() !== (stream?.endpoint ?? '') || enabled !== (stream?.enabled ?? true) || headers !== null;
  const invalid = !endpoint.trim() || !!urlErr || !!headerErr;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    try {
      await save.mutateAsync({
        endpoint: endpoint.trim(),
        enabled,
        headers: headers ? Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])) : undefined,
      });
      toast.success('Metrics stream saved');
    } catch (err) {
      toast.fromError(err, 'Could not save metrics stream');
    }
  };
  const onTest = async () => {
    try {
      const { stream: s } = await test.mutateAsync();
      if (s.lastError) toast.error('Test push failed', s.lastError);
      else toast.success('Metrics pushed', 'Your collector accepted the current minute of metrics.');
    } catch (err) {
      toast.fromError(err, 'Test push failed');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Remove the metrics stream?', body: 'NAV stops pushing metrics to your collector.', confirmText: 'Remove', danger: true }))) return;
    del.mutate(undefined, { onSuccess: () => toast.success('Metrics stream removed'), onError: (err) => toast.fromError(err, 'Could not remove metrics stream') });
  };

  return (
    <Section
      id="metrics-stream"
      title="Metrics Stream"
      description="Push CPU, memory, instance, request and latency metrics for every service every minute to an OpenTelemetry (OTLP/HTTP) collector."
    >
      {ms.isPending ? (
        <SkeletonRows rows={2} />
      ) : ms.isError ? (
        <ErrorState error={ms.error} onRetry={() => ms.refetch()} />
      ) : (
        <form onSubmit={submit}>
          {stream && (
            <div className="pb-2">
              <StreamStatus lastSentAt={stream.lastSentAt} lastError={stream.lastError} enabled={stream.enabled} />
            </div>
          )}
          <Row label="OTLP endpoint" description="The collector's metrics URL, e.g. https://otlp.example.com/v1/metrics.">
            <Field error={urlErr}>
              {(id) => <Input id={id} tall mono value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://otlp.example.com/v1/metrics" aria-label="OTLP endpoint" aria-invalid={!!urlErr} />}
            </Field>
          </Row>
          <Row label="Headers" description="Sent with every push, e.g. an API key. Values are encrypted and never shown again.">
            {headers === null ? (
              <div className="flex flex-wrap items-center gap-2">
                {stream?.headerNames.length ? (
                  stream.headerNames.map((n) => (
                    <Badge key={n} mono>
                      {n}
                    </Badge>
                  ))
                ) : (
                  <span className="text-[13px] text-fg-muted">No headers.</span>
                )}
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setHeaders((stream?.headerNames ?? []).map((name) => ({ name, value: '' })))}>
                  {stream?.headerNames.length ? 'Replace headers' : 'Add headers'}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input mono className="w-48" value={h.name} placeholder="x-api-key" aria-label={`Header ${i + 1} name`} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <Input mono type="password" className="min-w-0 flex-1" value={h.value} placeholder="Value" aria-label={`Header ${i + 1} value`} autoComplete="off" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    <IconButton label="Remove header" icon={<Trash2 className="size-3.5" />} onClick={() => setHeaders(headers.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setHeaders([...headers, { name: '', value: '' }])}>
                  Add header
                </Button>
                {headerErr && <p className="text-xs text-danger">{headerErr}</p>}
                <p className="text-xs text-fg-subtle">Saving replaces all stored headers with these.</p>
              </div>
            )}
          </Row>
          <Row label="Status">
            <Switch checked={enabled} onChange={setEnabled} label={enabled ? 'Streaming' : 'Paused'} />
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {stream && (
                <>
                  <Button variant="outline-danger" size="sm" loading={del.isPending} onClick={remove}>
                    Remove
                  </Button>
                  <Button size="sm" icon={<Send className="size-3.5" />} loading={test.isPending} disabled={dirty} onClick={onTest}>
                    Send test
                  </Button>
                </>
              )}
              {dirty && stream && (
                <Button size="sm" onClick={reset}>
                  Discard
                </Button>
              )}
              <Button size="sm" variant="primary" type="submit" loading={save.isPending} disabled={!dirty || invalid}>
                {stream ? 'Save changes' : 'Start streaming'}
              </Button>
            </div>
          </Row>
        </form>
      )}
    </Section>
  );
}

// Registry credentials ---------------------------------------------------------------------------

function RegistryForm({ initial, editing, onSubmit, formId }: { initial: RegistryCredentialInput; editing: boolean; onSubmit: (v: Partial<RegistryCredentialInput>) => void; formId: string }) {
  const [v, setV] = useState(initial);
  const regErr = v.registry && !/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]*)?$/i.test(v.registry.trim()) ? 'Enter a registry host like ghcr.io.' : null;
  return (
    <form
      id={formId}
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.name.trim() || !v.registry.trim() || !v.username.trim() || regErr || (!editing && !v.password)) return;
        onSubmit({ name: v.name.trim(), registry: v.registry.trim(), username: v.username.trim(), ...(v.password ? { password: v.password } : {}) });
      }}
    >
      <Field label="Name" className="sm:col-span-2">
        {(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="GitHub Packages" autoFocus />}
      </Field>
      <Field label="Registry" error={regErr} hint="Host of the registry, e.g. ghcr.io, docker.io or registry.gitlab.com.">
        {(id) => <Input id={id} mono value={v.registry} onChange={(e) => setV({ ...v, registry: e.target.value })} placeholder="ghcr.io" aria-invalid={!!regErr} />}
      </Field>
      <Field label="Username">{(id) => <Input id={id} mono value={v.username} onChange={(e) => setV({ ...v, username: e.target.value })} autoComplete="off" />}</Field>
      <Field label={editing ? 'New password or token' : 'Password or token'} optional={editing} className="sm:col-span-2" hint={editing ? 'Leave empty to keep the saved one.' : 'Stored encrypted. It is never shown again.'}>
        {(id) => <Input id={id} mono type="password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} autoComplete="new-password" />}
      </Field>
    </form>
  );
}

export function RegistrySection() {
  const { ws } = useWorkspace();
  const creds = useRegistryCredentials(ws);
  const create = useCreateRegistryCredential(ws);
  const update = useUpdateRegistryCredential(ws);
  const del = useDeleteRegistryCredential(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<RegistryCredential | 'new' | null>(null);

  const submit = async (v: Partial<RegistryCredentialInput>) => {
    try {
      if (editing === 'new') await create.mutateAsync(v as RegistryCredentialInput);
      else if (editing) await update.mutateAsync({ id: editing.id, ...v });
      toast.success(editing === 'new' ? 'Credential added' : 'Credential updated');
      setEditing(null);
    } catch (err) {
      toast.fromError(err, 'Could not save credential');
    }
  };
  const remove = async (c: RegistryCredential) => {
    if (!(await confirm({ title: `Delete ${c.name}?`, body: 'Services using it will pull their image anonymously from the next deploy on.', confirmText: 'Delete', danger: true }))) return;
    del.mutate(c.id, { onSuccess: () => toast.success('Credential deleted'), onError: (e) => toast.fromError(e, 'Could not delete credential') });
  };

  return (
    <Section id="registry" title="Registry Credentials" description="Pull images for image-backed services from private registries. Pick a credential in the service's settings.">
      <div className="mb-4 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          Add credential
        </Button>
      </div>
      {creds.isPending ? (
        <SkeletonRows rows={2} />
      ) : creds.isError ? (
        <ErrorState error={creds.error} onRetry={() => creds.refetch()} />
      ) : !creds.data.items.length ? (
        <Empty compact title="No registry credentials" description="Public images need none." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Registry</Th>
              <Th className="hidden sm:table-cell">Username</Th>
              <Th className="hidden md:table-cell">Added</Th>
              <Th className="w-20">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {creds.data.items.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td className="font-mono text-xs">{c.registry}</Td>
                <Td className="hidden font-mono text-xs text-fg-muted sm:table-cell">{c.username}</Td>
                <Td className="hidden text-fg-muted md:table-cell">
                  <RelativeTime value={c.createdAt} />
                </Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <IconButton label={`Edit ${c.name}`} icon={<Pencil className="size-3.5" />} onClick={() => setEditing(c)} />
                    <IconButton label={`Delete ${c.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => remove(c)} />
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add registry credential' : 'Edit registry credential'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="registry-form" loading={create.isPending || update.isPending}>
              {editing === 'new' ? 'Add credential' : 'Save changes'}
            </Button>
          </>
        }
      >
        {editing && (
          <RegistryForm
            key={editing === 'new' ? 'new' : editing.id}
            formId="registry-form"
            editing={editing !== 'new'}
            initial={editing === 'new' ? { name: '', registry: '', username: '', password: '' } : { name: editing.name, registry: editing.registry, username: editing.username, password: '' }}
            onSubmit={submit}
          />
        )}
      </Dialog>
    </Section>
  );
}
