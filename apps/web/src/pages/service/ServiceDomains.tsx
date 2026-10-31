import { useState, type FormEvent } from 'react';
import { Globe, ShieldCheck, Trash2 } from 'lucide-react';
import type { Service } from '@nav/shared';
import { useAddDomain, useCustomDomains, useDeleteDomain, useVerifyDomain } from '@/api/services';
import { Button, Card, CardBody, CardHeader, CopyButton, ErrorState, IconButton, Input, Skeleton, StatusPill, useConfirm, useToast } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';

export function CustomDomainsCard({ service }: { service: Service }) {
  const { isAdmin } = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const domains = useCustomDomains(service.id);
  const add = useAddDomain(service.id);
  const verify = useVerifyDomain(service.id);
  const del = useDeleteDomain(service.id);
  const [domain, setDomain] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) return;
    try {
      await add.mutateAsync(d);
      setDomain('');
      toast.success('Domain added', 'Create the DNS record shown, then click Verify.');
    } catch (err) {
      toast.fromError(err, 'Could not add domain');
    }
  };

  return (
    <Card>
      <CardHeader title="Custom domains" description="Point your own domain at this service. NAV verifies DNS and issues a TLS certificate automatically." />
      <CardBody className="space-y-4">
        {isAdmin && (
          <form onSubmit={submit} className="flex flex-wrap gap-2">
            <Input
              className="min-w-0 flex-1"
              leading={<Globe className="size-3.5" />}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="app.example.com"
              aria-label="Domain name"
            />
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!domain.trim()}>
              Add domain
            </Button>
          </form>
        )}
        {domains.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : domains.isError ? (
          <ErrorState error={domains.error} onRetry={() => domains.refetch()} />
        ) : !domains.data.items.length ? (
          <p className="text-[13px] text-fg-subtle">No custom domains. {service.url ? `Your service is reachable at ${service.url}.` : ''}</p>
        ) : (
          <ul className="space-y-3">
            {domains.data.items.map((d) => (
              <li key={d.id} className="rounded-lg border border-border bg-bg-elevated p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-medium text-fg">{d.domain}</span>
                  <StatusPill status={d.verificationStatus} />
                  {d.verificationStatus === 'verified' && <StatusPill status={d.certStatus} label={d.certStatus === 'issued' ? 'TLS issued' : undefined} />}
                  {d.redirectTo && <span className="text-xs text-fg-subtle">redirects → {d.redirectTo}</span>}
                  <div className="ml-auto flex items-center gap-1">
                    {isAdmin && d.verificationStatus !== 'verified' && (
                      <Button
                        size="xs"
                        icon={<ShieldCheck className="size-3" />}
                        loading={verify.isPending && verify.variables === d.id}
                        onClick={async () => {
                          try {
                            const res = await verify.mutateAsync(d.id);
                            if (res.verificationStatus === 'verified') toast.success('Domain verified', 'Issuing TLS certificate…');
                            else toast.error('Not verified yet', res.lastError ?? 'DNS record not found. Changes can take a few minutes to propagate.');
                          } catch (err) {
                            toast.fromError(err, 'Verification failed');
                          }
                        }}
                      >
                        Verify
                      </Button>
                    )}
                    {isAdmin && (
                      <IconButton
                        label={`Remove ${d.domain}`}
                        icon={<Trash2 className="size-3.5" />}
                        onClick={async () => {
                          if (!(await confirm({ title: `Remove ${d.domain}?`, body: 'Traffic to this domain will stop reaching the service.', confirmText: 'Remove', danger: true }))) return;
                          try {
                            await del.mutateAsync(d.id);
                            toast.success('Domain removed');
                          } catch (err) {
                            toast.fromError(err);
                          }
                        }}
                      />
                    )}
                  </div>
                </div>
                {d.verificationStatus !== 'verified' && (
                  <div className="mt-2 overflow-x-auto rounded-md border border-border bg-surface text-xs">
                    <table className="w-full">
                      <thead className="text-left text-fg-subtle">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">Type</th>
                          <th className="px-2 py-1.5 font-medium">Name</th>
                          <th className="px-2 py-1.5 font-medium">Value</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        <tr className="border-t border-border">
                          <td className="px-2 py-1.5">{d.dnsRecordType}</td>
                          <td className="px-2 py-1.5">{d.domain}</td>
                          <td className="px-2 py-1.5">
                            <span className="inline-flex items-center gap-1">
                              {d.dnsTarget}
                              <CopyButton value={d.dnsTarget} size="xs" label="Copy DNS target" />
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
                {d.lastError && <p className="mt-2 text-xs text-danger">{d.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
