import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Download, Eye, Lock, Pause, Play, Trash2 } from 'lucide-react';
import type { LogLine } from '@nav/shared';
import { KEY_VALUE_PLANS, KEY_VALUE_POLICIES } from '@nav/shared';
import { useDeleteKeyValue, useKeyValueCredentials, useKeyValueLogs, useKeyValuePlans, useUpdateKeyValue } from '@/api/keyvalue';
import { IpRulesEditor, normalizeRules, rulesValid, type IpRule } from '@/components/IpRulesEditor';
import { LogViewer } from '@/components/logs/LogViewer';
import { PlanPicker } from '@/components/PlanPicker';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ErrorState,
  Input,
  SecretValue,
  Select,
  SettingRow,
  StatusPill,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatMemory } from '@/lib/format';
import { downloadText } from '@/lib/misc';
import { formatDateTime } from '@/lib/time';
import { useKeyValueCtx } from './context';
import { POLICY_HELP } from './NewKeyValue';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 border-b border-border px-4 py-3 last:border-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-fg">{children}</dd>
    </div>
  );
}

// Info -------------------------------------------------------------------------------------------

export function KeyValueInfoTab() {
  const { keyValue: k } = useKeyValueCtx();
  const { ws, canWrite } = useWorkspace();
  const [reveal, setReveal] = useState(false);
  const creds = useKeyValueCredentials(k.id, reveal && canWrite);
  const plan = KEY_VALUE_PLANS.find((p) => p.id === k.plan);
  const available = k.status === 'available';

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="General" />
        <dl>
          <Row label="Status">
            <StatusPill status={k.status} />
          </Row>
          <Row label="Instance type">
            {plan ? (
              <span>
                {plan.name} <span className="font-mono text-xs text-fg-muted">· {plan.cpu} vCPU · {formatMemory(plan.memoryMB)} · ${plan.priceMonthly}/mo</span>
              </span>
            ) : (
              k.plan
            )}
          </Row>
          <Row label="Maxmemory policy">
            <span className="font-mono text-xs">{k.maxmemoryPolicy}</span>
          </Row>
          <Row label="Created">
            <span title={formatDateTime(k.createdAt)}>
              <RelativeTime value={k.createdAt} />
            </span>
          </Row>
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Connections"
          description="Use the internal URL from services in this workspace; the external URL from your machine (subject to the inbound IP rules)."
          actions={
            canWrite &&
            available &&
            !reveal && (
              <Button size="sm" icon={<Eye className="size-3.5" />} onClick={() => setReveal(true)}>
                Reveal credentials
              </Button>
            )
          }
        />
        {!canWrite ? (
          <CardBody className="flex items-center gap-2 text-[13px] text-fg-muted">
            <Lock className="size-4" /> Connection credentials are only visible to developers and admins.
          </CardBody>
        ) : !available ? (
          <CardBody className="text-[13px] text-fg-muted">
            {k.status === 'creating' ? 'Connection details will be available once the instance finishes provisioning.' : 'Connection details are available while the instance is running.'}
          </CardBody>
        ) : reveal && creds.isError ? (
          <CardBody>
            <ErrorState error={creds.error} onRetry={() => creds.refetch()} title="Could not load credentials" />
          </CardBody>
        ) : (
          <dl>
            <Row label="Password">{creds.data ? <SecretValue value={creds.data.password} /> : <span className="font-mono text-xs text-fg-muted">••••••••</span>}</Row>
            <Row label="Internal URL">
              {creds.data?.internalUrl ? <SecretValue value={creds.data.internalUrl} /> : <span className="font-mono text-xs break-all text-fg-muted">{k.internalUrl ?? '—'}</span>}
            </Row>
            <Row label="External URL (TLS)">
              {!k.externalUrl ? (
                k.ipAllowList.length ? (
                  <span className="text-fg-muted">Starting the TLS endpoint…</span>
                ) : (
                  <span className="text-fg-muted">
                    External access is off.{' '}
                    <Link to={`/w/${ws}/key-value/${k.id}/settings`} className="text-accent hover:underline">
                      Add inbound IP rules
                    </Link>{' '}
                    to allow it.
                  </span>
                )
              ) : creds.data?.externalUrl ? (
                <SecretValue value={creds.data.externalUrl} />
              ) : (
                <span className="font-mono text-xs break-all text-fg-muted">{k.externalUrl}</span>
              )}
            </Row>
            {k.externalTls && (
              <Row label="TLS certificate">
                {k.externalTls.certificate === 'platform' ? (
                  <span>Platform certificate for this hostname: clients can verify it as usual.</span>
                ) : (
                  <div className="space-y-1">
                    <div>
                      Self-signed certificate generated by the node (no platform certificate is configured). Clients must pin it by fingerprint or
                      skip verification, e.g. <span className="font-mono text-xs">redis-cli --insecure</span>.
                    </div>
                    {k.externalTls.fingerprint && <div className="font-mono text-[11.5px] break-all text-fg-muted">SHA-256 {k.externalTls.fingerprint}</div>}
                  </div>
                )}
              </Row>
            )}
            {creds.data?.externalUrl && (
              <Row label="redis-cli command">
                <SecretValue value={`redis-cli --tls${k.externalTls?.certificate === 'self-signed' ? ' --insecure' : ''} -u ${creds.data.externalUrl}`} />
              </Row>
            )}
            {reveal && creds.isPending && (
              <div className="px-4 py-3 text-[13px] text-fg-muted">Loading credentials…</div>
            )}
          </dl>
        )}
      </Card>
    </div>
  );
}

// Logs -------------------------------------------------------------------------------------------

export function KeyValueLogsTab() {
  const { keyValue: k } = useKeyValueCtx();
  const [live, setLive] = useState(true);
  const logs = useKeyValueLogs(k.id, live);
  const lines = useMemo<LogLine[]>(
    () =>
      (logs.data?.items ?? []).map((l) => ({
        id: l.id,
        ts: l.ts,
        level: l.level,
        message: l.message,
        serviceId: null,
        databaseId: k.id,
        deployId: null,
        instanceId: null,
        runId: null,
        stream: 'system',
      })),
    [logs.data, k.id],
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-fg-muted">The latest 500 lines{live ? ', refreshed every 5 seconds' : ''}.</p>
        <div className="flex items-center gap-2">
          <Button size="sm" icon={live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => setLive((v) => !v)}>
            {live ? 'Pause' : 'Resume'}
          </Button>
          <Button
            size="sm"
            icon={<Download className="size-3.5" />}
            disabled={!lines.length}
            onClick={() => downloadText(`${k.slug || k.name}-logs.txt`, lines.map((l) => `${l.ts} [${l.level}] ${l.message}`).join('\n'))}
          >
            Download
          </Button>
        </div>
      </div>
      {logs.isError && <p className="text-xs text-danger">Could not load logs.</p>}
      <LogViewer label="Key Value logs" lines={lines} loading={logs.isPending} emptyText="No logs yet." />
    </div>
  );
}

// Settings ---------------------------------------------------------------------------------------

export function KeyValueSettingsTab() {
  const { keyValue: k } = useKeyValueCtx();
  const { ws, canWrite, isAdmin } = useWorkspace();
  const update = useUpdateKeyValue({ id: k.id, workspaceId: ws });
  const del = useDeleteKeyValue(ws);
  const meta = useKeyValuePlans();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const plans = meta.data?.plans ?? KEY_VALUE_PLANS;
  const policies = meta.data?.policies ?? [...KEY_VALUE_POLICIES];

  const [name, setName] = useState(k.name);
  const [policy, setPolicy] = useState(k.maxmemoryPolicy);
  const [plan, setPlan] = useState(k.plan);
  const [rules, setRules] = useState<IpRule[]>(k.ipAllowList);
  useEffect(() => setName(k.name), [k.name]);
  useEffect(() => setPolicy(k.maxmemoryPolicy), [k.maxmemoryPolicy]);
  useEffect(() => setPlan(k.plan), [k.plan]);
  useEffect(() => setRules(k.ipAllowList), [k.ipAllowList]);
  const rulesDirty = JSON.stringify(rules) !== JSON.stringify(k.ipAllowList);

  const patch = async (input: Parameters<typeof update.mutateAsync>[0], msg: string) => {
    try {
      await update.mutateAsync(input);
      toast.success(msg);
    } catch (e) {
      toast.fromError(e, 'Could not save changes');
    }
  };

  const savePlan = async () => {
    const p = plans.find((x) => x.id === plan);
    const ok = await confirm({ title: `Change plan to ${p?.name ?? plan}?`, body: 'The instance restarts with the new memory limit. Expect a brief interruption.', confirmText: 'Change plan' });
    if (ok) await patch({ plan }, 'Plan change started');
  };

  const saveRules = (e: FormEvent) => {
    e.preventDefault();
    if (rulesValid(rules)) void patch({ ipAllowList: normalizeRules(rules) }, 'Inbound IP rules updated');
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete ${k.name}?`,
      body: 'This permanently deletes the instance and all of its data. This cannot be undone.',
      typeToConfirm: k.name,
      confirmText: 'Delete Key Value',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(k.id);
      toast.success('Key Value deleted', k.name);
      navigate(`/w/${ws}/key-value`);
    } catch (e) {
      toast.fromError(e, 'Could not delete Key Value');
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="General" />
        <SettingRow title="Name" description="Display name in the dashboard.">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} aria-label="Key Value name" />
            {canWrite && (
              <Button onClick={() => patch({ name: name.trim() }, 'Key Value renamed')} disabled={!name.trim() || name === k.name} loading={update.isPending && name !== k.name}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow title="Maxmemory policy" description={POLICY_HELP[policy] ?? 'What gets evicted when the instance is full.'}>
          <div className="flex gap-2">
            <Select className="flex-1" value={policy} onChange={(e) => setPolicy(e.target.value)} options={policies.map((p) => ({ value: p, label: p }))} disabled={!canWrite} aria-label="Maxmemory policy" />
            {canWrite && (
              <Button onClick={() => patch({ maxmemoryPolicy: policy }, 'Eviction policy updated')} disabled={policy === k.maxmemoryPolicy}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
      </Card>

      <form onSubmit={saveRules}>
        <Card>
          <CardHeader title="Inbound IP rules" description="Only these sources may connect via the external URL, which is TLS only (rediss://). Services inside the workspace always connect over the private network." />
          <CardBody>
            <IpRulesEditor rows={rules} onChange={setRules} disabled={!canWrite} emptyText="No rules. External connections are blocked." footnote="Empty list blocks all external connections; add 0.0.0.0/0 to allow everyone." />
          </CardBody>
          {canWrite && (
            <CardFooter>
              {rulesDirty && <Button onClick={() => setRules(k.ipAllowList)}>Discard</Button>}
              <Button variant="primary" type="submit" loading={update.isPending && rulesDirty} disabled={!rulesDirty || !rulesValid(rules)}>
                Save rules
              </Button>
            </CardFooter>
          )}
        </Card>
      </form>

      <Card>
        <CardHeader title="Instance type" />
        <CardBody>
          <PlanPicker plans={plans} value={plan} onChange={setPlan} disabled={!canWrite} />
        </CardBody>
        {canWrite && (
          <CardFooter>
            <Button variant="primary" disabled={plan === k.plan} onClick={savePlan} loading={update.isPending && plan !== k.plan}>
              Change plan
            </Button>
          </CardFooter>
        )}
      </Card>

      {isAdmin && (
        <Card className="border-danger/40">
          <CardHeader title={<span className="text-danger">Danger zone</span>} />
          <SettingRow title="Delete Key Value" description="Permanently delete this instance and all of its data.">
            <Button variant="outline-danger" icon={<Trash2 className="size-3.5" />} loading={del.isPending} onClick={onDelete}>
              Delete Key Value
            </Button>
          </SettingRow>
        </Card>
      )}
    </div>
  );
}
