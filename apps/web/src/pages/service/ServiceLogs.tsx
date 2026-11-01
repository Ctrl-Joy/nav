import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Pause, Play, Search, Trash2 } from 'lucide-react';
import { buildUrl } from '@/api/client';
import { fetchServiceLogs, useInstances, type LogQuery } from '@/api/services';
import { LogViewer } from '@/components/logs/LogViewer';
import { useLogTail } from '@/components/logs/useLogTail';
import { Button, Input, Select } from '@/components/ui';
import { stripAnsi } from '@/lib/ansi';
import { downloadText } from '@/lib/misc';
import { useServiceCtx } from './context';

const STREAMS = [
  { value: '', label: 'All streams' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'build', label: 'Build' },
  { value: 'deploy', label: 'Deploy' },
  { value: 'cron', label: 'Cron' },
  { value: 'job', label: 'Jobs' },
  { value: 'workflow', label: 'Workflow runs' },
  { value: 'system', label: 'System' },
];
const LEVELS = [
  { value: '', label: 'All levels' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
];
const RANGES = [
  { value: '', label: 'Live tail' },
  { value: '15', label: 'Last 15 min' },
  { value: '60', label: 'Last hour' },
  { value: '360', label: 'Last 6 hours' },
  { value: '1440', label: 'Last 24 hours' },
];

export function ServiceLogsTab() {
  const { service } = useServiceCtx();
  const instances = useInstances(service.id);
  const [stream, setStream] = useState('runtime');
  const [level, setLevel] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [range, setRange] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [live, setLive] = useState(true);
  const [since, setSince] = useState<string | undefined>(undefined);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    setSince(range ? new Date(Date.now() - Number(range) * 60_000).toISOString() : undefined);
  }, [range]);

  const filters = useMemo<LogQuery>(
    () => ({ stream: stream || undefined, level: level || undefined, instanceId: instanceId || undefined, q: q || undefined, since }),
    [stream, level, instanceId, q, since],
  );
  const key = `svc-logs:${service.id}:${JSON.stringify(filters)}`;

  const fetchPage = useCallback(
    (p: { before?: number; limit: number }) => fetchServiceLogs(service.id, { ...filters, before: p.before, limit: p.limit }),
    [service.id, filters],
  );
  const streamUrl = useCallback(
    (after: number | undefined) => buildUrl(`/services/${service.id}/logs/stream`, { ...filters, since: after ? undefined : filters.since, after }),
    [service.id, filters],
  );

  const tail = useLogTail({ key, fetchPage, streamUrl, live: live && !range });

  const download = () => {
    const body = tail.lines.map((l) => `${l.ts} [${l.stream}] [${l.level}]${l.instanceId ? ` [${l.instanceId}]` : ''} ${stripAnsi(l.message)}`).join('\n');
    downloadText(`${service.slug}-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, body);
  };

  const instanceOptions = [
    { value: '', label: 'All instances' },
    ...(instances.data?.items ?? []).map((i) => ({ value: i.id, label: `${i.id.slice(-8)} · ${i.status}` })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-64"
          leading={<Search className="size-3.5" />}
          placeholder="Search logs…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search logs"
        />
        <Select size="sm" className="w-32" aria-label="Stream" value={stream} onChange={(e) => setStream(e.target.value)} options={STREAMS} />
        <Select size="sm" className="w-28" aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)} options={LEVELS} />
        <Select size="sm" className="w-44" aria-label="Instance" value={instanceId} onChange={(e) => setInstanceId(e.target.value)} options={instanceOptions} />
        <Select size="sm" className="w-36" aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)} options={RANGES} />
        <div className="ml-auto flex items-center gap-1.5">
          {!range && (
            <Button size="sm" icon={live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => setLive((l) => !l)}>
              {live ? 'Pause' : 'Resume'}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={tail.clear}>
            Clear
          </Button>
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={download} disabled={!tail.lines.length}>
            Download
          </Button>
        </div>
      </div>
      {tail.error && <p className="text-xs text-danger">{tail.error}</p>}
      <LogViewer
        lines={tail.lines}
        highlight={q}
        loading={tail.loading}
        state={range ? undefined : tail.state}
        hasOlder={tail.hasOlder}
        loadingOlder={tail.loadingOlder}
        onLoadOlder={tail.loadOlder}
        showStream
        showInstance
        height="h-[65vh]"
        label={`${service.name} logs`}
        emptyText={q ? `No log lines match “${q}”.` : 'No logs yet. Output from your service will stream here.'}
      />
      <p className="text-xs text-fg-subtle">Showing up to the latest 5,000 lines ({tail.lines.length.toLocaleString()} loaded).</p>
    </div>
  );
}
