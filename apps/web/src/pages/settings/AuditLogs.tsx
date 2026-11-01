import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileClock, Search } from 'lucide-react';
import { useAuditLogs } from '@/api/integrations';
import type { AuditLogEntry } from '@/api/types';
import { RelativeTime } from '@/components/RelativeTime';
import { Badge, Button, Empty, ErrorState, Input, PageHeader, SkeletonRows, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { downloadText } from '@/lib/misc';
import { formatDateTime } from '@/lib/time';
import { useTitle } from '@/lib/useTitle';

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** "service.update" -> tone by verb. */
function actionTone(action: string) {
  if (/delete|remove|revoke/.test(action)) return 'danger' as const;
  if (/create|add|invite/.test(action)) return 'success' as const;
  if (/shell|secret|credential/.test(action)) return 'warning' as const;
  return 'neutral' as const;
}

function EntryRow({ e }: { e: AuditLogEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <Tr interactive onClick={() => setOpen((o) => !o)}>
        <Td className="w-8 pr-0 text-fg-subtle">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</Td>
        <Td>
          <span title={formatDateTime(e.createdAt)} className="whitespace-nowrap text-fg-muted">
            <RelativeTime value={e.createdAt} />
          </span>
        </Td>
        <Td>
          <Badge tone={actionTone(e.action)} mono>
            {e.action}
          </Badge>
        </Td>
        <Td>
          <div className="truncate">{e.actorEmail ?? '—'}</div>
          {e.actorKind && e.actorKind !== 'session' && <div className="text-[11px] text-fg-subtle">via {e.actorKind === 'api_key' ? 'API key' : e.actorKind}</div>}
        </Td>
        <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">
          {e.targetType ? `${e.targetType}${e.targetId ? ` · ${e.targetId}` : ''}` : '—'}
        </Td>
        <Td className="hidden font-mono text-xs text-fg-muted lg:table-cell">{e.ip ?? '—'}</Td>
      </Tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-panel px-4 py-3">
            <dl className="grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-[120px_minmax(0,1fr)]">
              <dt className="text-fg-muted">Request</dt>
              <dd className="font-mono break-all">{e.data?.method ? `${e.data.method} ${e.data.path ?? ''}` : '—'}</dd>
              <dt className="text-fg-muted">Fields changed</dt>
              <dd className="font-mono break-all">{e.data?.fields?.length ? e.data.fields.join(', ') : '—'}</dd>
              <dt className="text-fg-muted">Target</dt>
              <dd className="font-mono break-all">{e.targetType ? `${e.targetType} ${e.targetId ?? ''}` : '—'}</dd>
              <dt className="text-fg-muted">IP address</dt>
              <dd className="font-mono">{e.ip ?? '—'}</dd>
              <dt className="text-fg-muted">User agent</dt>
              <dd className="break-all text-fg-muted">{e.userAgent || '—'}</dd>
              <dt className="text-fg-muted">Time</dt>
              <dd>{formatDateTime(e.createdAt)}</dd>
            </dl>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function AuditLogsPage() {
  useTitle('Audit logs');
  const { ws, isAdmin } = useWorkspace();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const filters = { action: useDebounced(action.trim()) || undefined, actor: useDebounced(actor.trim()) || undefined };
  const logs = useAuditLogs(ws, filters);
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];

  if (!isAdmin) {
    return <Empty title="Admins only" description="Only workspace owners and admins can view the audit log." />;
  }

  return (
    <div>
      <PageHeader
        icon={<FileClock className="size-4" />}
        title="Audit Logs"
        description="Every change made in this workspace through the dashboard, CLI or API."
        actions={
          <Button icon={<Download className="size-3.5" />} disabled={!items.length} onClick={() => downloadText(`audit-logs-${ws}.json`, JSON.stringify(items, null, 2), 'application/json')}>
            Export loaded
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          className="w-full sm:w-64"
          leading={<Search className="size-3.5" />}
          placeholder="Action, e.g. service. or service.delete"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="Filter by action"
        />
        <Input className="w-full sm:w-64" type="email" placeholder="Member email" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Filter by member email" />
      </div>
      {logs.isPending ? (
        <SkeletonRows rows={8} />
      ) : logs.isError ? (
        <ErrorState error={logs.error} onRetry={() => logs.refetch()} />
      ) : !items.length ? (
        <Empty
          compact
          icon={<FileClock className="size-4" />}
          title={filters.action || filters.actor ? 'No matching entries' : 'No audit entries yet'}
          description={filters.action || filters.actor ? 'Try a shorter action prefix or a different email.' : 'Changes made in this workspace will appear here.'}
        />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th className="w-8">
                  <span className="sr-only">Expand</span>
                </Th>
                <Th>Time</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th className="hidden md:table-cell">Target</Th>
                <Th className="hidden lg:table-cell">IP</Th>
              </tr>
            </THead>
            <TBody>
              {items.map((e) => (
                <EntryRow key={e.id} e={e} />
              ))}
            </TBody>
          </Table>
          {logs.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
