import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { DATABASE_PLANS } from '@nav/shared';
import { useDatabaseCredentials } from '@/api/databases';
import { RelativeTime } from '@/components/RelativeTime';
import { Card, CardBody, CardHeader, CopyField, ErrorState, SecretValue, Skeleton, StatusPill } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatMemory } from '@/lib/format';
import { formatDateTime } from '@/lib/time';
import { useDatabaseCtx } from './context';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 border-b border-border px-4 py-3 last:border-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-fg">{children}</dd>
    </div>
  );
}

export function DatabaseInfoTab() {
  const { database: d } = useDatabaseCtx();
  const { canWrite } = useWorkspace();
  const creds = useDatabaseCredentials(d.id, canWrite && d.status !== 'creating');
  const plan = DATABASE_PLANS.find((p) => p.id === d.plan);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="General" />
        <dl>
          <Row label="Status">
            <StatusPill status={d.status} />
          </Row>
          <Row label="Instance type">
            {plan ? (
              <span>
                {plan.name} <span className="font-mono text-xs text-fg-muted">· {plan.cpu} vCPU · {formatMemory(plan.memoryMB)} · ${plan.priceMonthly}/mo</span>
              </span>
            ) : (
              d.plan
            )}
          </Row>
          <Row label="PostgreSQL version">{d.pgVersion}</Row>
          <Row label="Storage">{d.diskGB} GB</Row>
          <Row label="Database / user">
            <span className="font-mono text-xs">
              {d.dbName} / {d.dbUser}
            </span>
          </Row>
          <Row label="Created">
            <span title={formatDateTime(d.createdAt)}>
              <RelativeTime value={d.createdAt} />
            </span>
          </Row>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Connections" description="Use the internal URL from services in this workspace; the external URL from your machine (subject to the access control list)." />
        {!canWrite ? (
          <CardBody className="flex items-center gap-2 text-[13px] text-fg-muted">
            <Lock className="size-4" /> Connection credentials are only visible to developers and admins.
          </CardBody>
        ) : d.status === 'creating' ? (
          <CardBody className="text-[13px] text-fg-muted">Credentials will be available once the database finishes provisioning.</CardBody>
        ) : creds.isPending ? (
          <CardBody className="space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardBody>
        ) : creds.isError ? (
          <CardBody>
            <ErrorState error={creds.error} onRetry={() => creds.refetch()} title="Could not load credentials" />
          </CardBody>
        ) : (
          <dl>
            <Row label="Hostname">
              <CopyField value={creds.data.host} />
            </Row>
            <Row label="Port">
              <CopyField value={String(creds.data.port)} />
            </Row>
            <Row label="Database">
              <CopyField value={creds.data.database} />
            </Row>
            <Row label="Username">
              <CopyField value={creds.data.user} />
            </Row>
            <Row label="Password">
              <SecretValue value={creds.data.password} />
            </Row>
            <Row label="Internal database URL">
              <SecretValue value={creds.data.internalUrl} />
            </Row>
            <Row label="External database URL">
              <SecretValue value={creds.data.externalUrl} />
            </Row>
            <Row label="PSQL command">
              <SecretValue value={creds.data.psqlCommand} />
            </Row>
            {creds.data.pooledInternalUrl && (
              <Row label="Pooled internal URL">
                <SecretValue value={creds.data.pooledInternalUrl} />
              </Row>
            )}
            {creds.data.pooledExternalUrl && (
              <Row label="Pooled external URL">
                <SecretValue value={creds.data.pooledExternalUrl} />
              </Row>
            )}
            {creds.data.replicas?.map((r) => (
              <Row key={r.id} label={`Read replica: ${r.name}`}>
                <SecretValue value={r.externalUrl} />
              </Row>
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}
