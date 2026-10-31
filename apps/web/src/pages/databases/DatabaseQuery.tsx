import { useMemo, useState } from 'react';
import { AlertTriangle, Download, History, Lock, Play } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { useRunQuery } from '@/api/databases';
import type { QueryResult } from '@/api/types';
import { Button, Card, CardBody, CardHeader, CopyButton, Empty, Kbd, Table, TBody, Td, Th, THead, Textarea, Tr } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { downloadText } from '@/lib/misc';
import { useDatabaseCtx } from './context';

interface Grid {
  columns: string[];
  rows: unknown[][];
}

function toGrid(r: QueryResult): Grid {
  const columns = (r.columns ?? []).map((c) => (typeof c === 'string' ? c : c.name));
  const rows = (r.rows ?? []).map((row) => {
    if (Array.isArray(row)) return row;
    const rec = row as Record<string, unknown>;
    const cols = columns.length ? columns : Object.keys(rec);
    return cols.map((c) => rec[c]);
  });
  if (!columns.length && r.rows?.length && !Array.isArray(r.rows[0])) {
    return { columns: Object.keys(r.rows[0] as Record<string, unknown>), rows };
  }
  return { columns, rows };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function toCsv(g: Grid): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [g.columns.map(esc).join(','), ...g.rows.map((r) => r.map((v) => esc(cellText(v))).join(','))].join('\n');
}

export function DatabaseQueryTab() {
  const { database: d } = useDatabaseCtx();
  const { canWrite } = useWorkspace();
  const run = useRunQuery(d.id);
  const [sql, setSql] = useState('SELECT now(), version();');
  const [history, setHistory] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grid = useMemo(() => (result ? toGrid(result) : null), [result]);

  if (!canWrite) {
    return <Empty icon={<Lock className="size-4" />} title="Query console is for developers" description="Viewers cannot run SQL against workspace databases." />;
  }

  const execute = async () => {
    const text = sql.trim();
    if (!text || run.isPending) return;
    setError(null);
    try {
      const r = await run.mutateAsync(text);
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    }
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 10));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-fg-muted">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          Queries run <strong className="text-fg">read-write</strong> as the database owner against <span className="font-mono">{d.dbName}</span>. 5 second timeout, results capped at 1000
          rows.
        </span>
      </div>
      <Card>
        <CardHeader
          title="SQL"
          actions={
            <>
              <span className="hidden items-center gap-1 text-xs text-fg-subtle sm:flex">
                <Kbd>Ctrl</Kbd>
                <Kbd>↵</Kbd> to run
              </span>
              <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={run.isPending} disabled={!sql.trim() || d.status !== 'available'} onClick={execute}>
                Run
              </Button>
            </>
          }
        />
        <CardBody>
          <Textarea
            mono
            rows={8}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void execute();
              }
            }}
            aria-label="SQL query"
            placeholder="SELECT * FROM users LIMIT 10;"
          />
          {d.status !== 'available' && <p className="mt-2 text-xs text-fg-subtle">The database must be available to run queries.</p>}
          {history.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <History className="size-3.5 text-fg-subtle" aria-label="History" />
              {history.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setSql(h)}
                  title={h}
                  className="max-w-56 truncate rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg-muted hover:text-fg"
                >
                  {h}
                </button>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-3">
          <p className="text-[13px] font-medium text-danger">Query failed</p>
          <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-fg-muted">{error}</pre>
        </div>
      )}

      {result && grid && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
            <span>
              {result.command ? `${result.command} · ` : ''}
              {result.rowCount ?? grid.rows.length} row{(result.rowCount ?? grid.rows.length) === 1 ? '' : 's'} · {Math.round(result.durationMs)} ms
            </span>
            {grid.columns.length > 0 && (
              <div className="flex items-center gap-1">
                <CopyButton value={toCsv(grid)} label="Copy as CSV" />
                <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => downloadText(`${d.slug || 'query'}-result.csv`, toCsv(grid), 'text/csv')}>
                  CSV
                </Button>
              </div>
            )}
          </div>
          {grid.columns.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-3 py-4 text-[13px] text-fg-muted">Query executed. No rows returned.</p>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <Table>
                <THead>
                  <tr>
                    {grid.columns.map((c, i) => (
                      <Th key={`${c}-${i}`} className="font-mono normal-case">
                        {c}
                      </Th>
                    ))}
                  </tr>
                </THead>
                <TBody>
                  {grid.rows.map((r, i) => (
                    <Tr key={i}>
                      {grid.columns.map((_, j) => {
                        const v = r[j];
                        return (
                          <Td key={j} className="h-8 max-w-80 truncate font-mono text-xs" title={cellText(v)}>
                            {v === null || v === undefined ? <span className="text-fg-subtle italic">NULL</span> : cellText(v)}
                          </Td>
                        );
                      })}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
