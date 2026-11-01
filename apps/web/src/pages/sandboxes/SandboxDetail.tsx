import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ArrowUp, Camera, Download, File, Folder, Link2, RotateCw, Trash2, Upload } from 'lucide-react';
import type { Sandbox } from '@nav/shared';
import {
  sandboxDownloadUrl, useDeleteSandbox, useSandbox, useSandboxFileActions, useSandboxFiles, useSandboxSnapshots, useSnapshotActions,
} from '@/api/sandboxes';
import { RelativeTime } from '@/components/RelativeTime';
import {
  Badge, Button, Card, CardBody, CardHeader, CopyField, Empty, ErrorState, IconButton, Input, PageHeader, SkeletonRows, StatusDot, StatusPill,
  Table, TBody, Td, Th, THead, Tr, Tabs, useConfirm, useToast, type Tone,
} from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { formatBytes } from '@/lib/format';
import { useTitle } from '@/lib/useTitle';
import { Countdown } from './SandboxesList';

type ConsoleState = { kind: 'connecting' } | { kind: 'ready'; tty: boolean; driver: string } | { kind: 'exited'; code: number | null } | { kind: 'closed'; message: string };
const STATE_TONE: Record<ConsoleState['kind'], Tone> = { connecting: 'warning', ready: 'success', exited: 'neutral', closed: 'danger' };

const streamUrl = (id: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/sandboxes/${id}/exec/stream`;

/** An interactive shell in the sandbox over the streaming exec endpoint (same approach as the service shell). */
function SandboxConsole({ sandbox }: { sandbox: Sandbox }) {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ConsoleState>({ kind: 'connecting' });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#0a0a0a', foreground: '#d6dde6', cursor: '#d6dde6', selectionBackground: '#33415580' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    setState({ kind: 'connecting' });
    term.write('\x1b[2mConnecting…\x1b[0m\r\n');

    const ws = new WebSocket(streamUrl(sandbox.id));
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    let tty = true;
    let ready = false;
    let finished = false;
    let line = '';
    const send = (text: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(text)); };

    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', tty: true, cols: term.cols, rows: term.rows }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        term.write(bytes[0] === 2 ? `\x1b[31m${new TextDecoder().decode(bytes.subarray(1))}\x1b[0m` : bytes.subarray(1));
        return;
      }
      let msg: { type?: string; tty?: boolean; driver?: string; code?: number | null; message?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'started') {
        ready = true;
        tty = msg.tty !== false;
        term.options.convertEol = !tty;
        setState({ kind: 'ready', tty, driver: msg.driver ?? '' });
        if (!tty) term.write('\x1b[2mNo TTY (process driver): lines are sent when you press Enter.\x1b[0m\r\n');
        term.focus();
      } else if (msg.type === 'exit') {
        finished = true;
        term.write(`\r\n\x1b[2mShell exited with code ${msg.code ?? '?'}.\x1b[0m\r\n`);
        setState({ kind: 'exited', code: msg.code ?? null });
      } else if (msg.type === 'error') {
        finished = true;
        term.write(`\r\n\x1b[31m${msg.message ?? 'Error'}\x1b[0m\r\n`);
        setState({ kind: 'closed', message: msg.message ?? 'Error' });
      }
    };
    ws.onclose = () => {
      if (finished) return;
      const message = ready ? 'Connection closed.' : 'Could not open a shell. The sandbox may have stopped or expired.';
      term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
      setState({ kind: 'closed', message });
    };

    const onData = term.onData((data) => {
      if (!ready) return;
      if (tty) return send(data);
      if (data.startsWith('\x1b')) return;
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          term.write('\r\n');
          send(`${line}\n`);
          line = '';
        } else if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = line.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch === '\x03') {
          line = '';
          term.write('^C\r\n');
        } else if (ch >= ' ') {
          line += ch;
          term.write(ch);
        }
      }
    });
    const onResize = term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not attached yet */
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [sandbox.id, attempt]);

  const label =
    state.kind === 'connecting' ? 'Connecting…'
      : state.kind === 'ready' ? `Connected${state.driver ? ` · ${state.driver}` : ''}${state.tty ? '' : ' · line mode'}`
        : state.kind === 'exited' ? `Exited${state.code != null ? ` (code ${state.code})` : ''}` : state.message;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => setAttempt((n) => n + 1)}>Reconnect</Button>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-[13px] text-fg-muted" role="status">
          <StatusDot tone={STATE_TONE[state.kind]} pulse={state.kind === 'connecting'} />
          <span className="truncate">{label}</span>
        </span>
      </div>
      <div className="overflow-hidden rounded-[3px] border border-border-strong bg-[#0a0a0a] p-2">
        <div ref={host} className="h-[min(520px,60dvh)] w-full" aria-label="Sandbox console" />
      </div>
      <p className="text-xs text-fg-subtle">The shell starts in /workspace. Every session is recorded in the workspace audit log (the command, never its output).</p>
    </div>
  );
}

function FileBrowser({ sandbox }: { sandbox: Sandbox }) {
  const [dir, setDir] = useState('');
  const files = useSandboxFiles(sandbox.id, dir, true);
  const { upload, remove } = useSandboxFileActions(sandbox.id);
  const confirm = useConfirm();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const parts = dir ? dir.split('/') : [];
  const join = (name: string) => (dir ? `${dir}/${name}` : name);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton label="Up one level" icon={<ArrowUp className="size-3.5" />} disabled={!dir} onClick={() => setDir(parts.slice(0, -1).join('/'))} />
        <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-[13px]">
          <button type="button" className="text-fg-muted hover:text-fg" onClick={() => setDir('')}>/workspace</button>
          {parts.map((p, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-fg-subtle">/</span>
              <button type="button" className="text-fg-muted hover:text-fg" onClick={() => setDir(parts.slice(0, i + 1).join('/'))}>{p}</button>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex gap-2">
          <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => files.refetch()}>Refresh</Button>
          <Button size="sm" variant="primary" icon={<Upload className="size-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>Upload</Button>
          <input
            ref={input}
            type="file"
            className="hidden"
            multiple
            onChange={async (e) => {
              for (const f of Array.from(e.target.files ?? [])) {
                await upload.mutateAsync({ path: join(f.name), file: f }).catch((err) => toast.fromError(err, `Could not upload ${f.name}`));
              }
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {files.isPending ? (
        <SkeletonRows rows={4} />
      ) : files.isError ? (
        <ErrorState error={files.error} onRetry={() => files.refetch()} />
      ) : !files.data.items.length ? (
        <Empty compact title="Empty directory" description="Upload files here, or create them from the console or the API." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th className="hidden sm:table-cell">Size</Th>
              <Th className="hidden md:table-cell">Modified</Th>
              <Th />
            </tr>
          </THead>
          <TBody>
            {files.data.items.map((f) => (
              <Tr key={f.path} interactive={f.type === 'dir'} onClick={() => f.type === 'dir' && setDir(f.path)}>
                <Td>
                  <span className="flex items-center gap-2 font-mono text-[13px]">
                    {f.type === 'dir' ? <Folder className="size-3.5 text-accent" /> : f.type === 'symlink' ? <Link2 className="size-3.5 text-fg-muted" /> : <File className="size-3.5 text-fg-muted" />}
                    {f.name}
                  </span>
                </Td>
                <Td className="hidden text-fg-muted sm:table-cell">{f.type === 'file' ? formatBytes(f.size) : '—'}</Td>
                <Td className="hidden text-fg-muted md:table-cell"><RelativeTime value={f.modifiedAt} /></Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    {f.type === 'file' && (
                      <a href={sandboxDownloadUrl(sandbox.id, f.path)} download={f.name} aria-label={`Download ${f.name}`} title="Download" className="inline-flex size-7 items-center justify-center rounded-[3px] text-fg-muted hover:bg-surface-2 hover:text-fg">
                        <Download className="size-3.5" />
                      </a>
                    )}
                    <IconButton
                      label={`Delete ${f.name}`}
                      icon={<Trash2 className="size-3.5" />}
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete ${f.path}?`, body: f.type === 'dir' ? 'The directory and everything in it are deleted.' : undefined, confirmText: 'Delete', danger: true }))) return;
                        remove.mutate({ path: f.path, recursive: f.type === 'dir' }, { onError: (err) => toast.fromError(err, 'Could not delete') });
                      }}
                    />
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function SnapshotsTab({ sandbox }: { sandbox: Sandbox }) {
  const { ws } = useWorkspace();
  const snaps = useSandboxSnapshots(ws);
  const { take } = useSnapshotActions(ws);
  const toast = useToast();
  const [name, setName] = useState('');
  const mine = (snaps.data?.items ?? []).filter((s) => s.sandboxId === sandbox.id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input className="w-full sm:w-64" placeholder="Snapshot name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Snapshot name" />
        <Button
          variant="primary"
          icon={<Camera className="size-4" />}
          loading={take.isPending}
          disabled={sandbox.status !== 'running'}
          onClick={() => take.mutate({ id: sandbox.id, name: name.trim() || undefined }, {
            onSuccess: (s) => { setName(''); toast.success('Snapshot saved', `${s.id} · ${formatBytes(s.sizeBytes)}`); },
            onError: (e) => toast.fromError(e, 'Could not take a snapshot'),
          })}
        >
          Take snapshot
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">A snapshot saves /workspace to the artifact store. Create new sandboxes from it on the Sandboxes page, or with snapshotId in the API.</p>
      {mine.length > 0 && (
        <Table>
          <THead>
            <tr><Th>Snapshot</Th><Th>Status</Th><Th>Size</Th><Th>Taken</Th></tr>
          </THead>
          <TBody>
            {mine.map((s) => (
              <Tr key={s.id}>
                <Td><div className="font-medium">{s.name ?? s.id}</div><div className="font-mono text-[11px] text-fg-subtle">{s.id}</div></Td>
                <Td><StatusPill status={s.status} /></Td>
                <Td className="text-fg-muted">{formatBytes(s.sizeBytes)}</Td>
                <Td className="text-fg-muted"><RelativeTime value={s.createdAt} /></Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

type TabValue = 'console' | 'files' | 'snapshots';

export function SandboxDetailPage() {
  const { sandboxId } = useParams();
  const { ws, canWrite } = useWorkspace();
  const sandbox = useSandbox(sandboxId);
  const del = useDeleteSandbox(ws);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabValue>('console');
  useTitle(sandbox.data?.name ?? sandboxId ?? 'Sandbox');

  if (sandbox.isPending) return <SkeletonRows />;
  if (sandbox.isError) return <ErrorState error={sandbox.error} onRetry={() => sandbox.refetch()} />;
  const s = sandbox.data;
  const live = s.status === 'running';

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{s.name ?? s.id} <StatusPill status={s.status} /></span>}
        description={<span className="font-mono text-xs">{s.id}</span>}
        actions={canWrite && (live || s.status === 'failed') && (
          <Button
            variant="outline-danger"
            icon={<Trash2 className="size-4" />}
            loading={del.isPending}
            onClick={async () => {
              if (!(await confirm({ title: 'Delete this sandbox?', body: 'Running commands are killed and its files are removed. Snapshots are kept.', confirmText: 'Delete', danger: true }))) return;
              del.mutate(s.id, { onSuccess: () => navigate(`/w/${ws}/sandboxes`), onError: (e) => toast.fromError(e, 'Could not delete the sandbox') });
            }}
          >
            Delete
          </Button>
        )}
      />
      {!s.isolated && s.driver && (
        <div className="rounded-[3px] border border-warning/40 bg-warning-soft px-3 py-2 text-[13px]">
          This sandbox runs on the <strong>process driver</strong>: commands are ordinary processes on the node, with no container isolation. Use it for development only.
        </div>
      )}
      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-fg-subtle">Image</dt><dd className="font-mono">{s.image}</dd></div>
            <div><dt className="text-fg-subtle">Plan</dt><dd>{s.plan}</dd></div>
            <div><dt className="text-fg-subtle">Network</dt><dd>{s.networkAccess === 'egress' ? 'Outbound internet' : 'None'}</dd></div>
            <div><dt className="text-fg-subtle">Expires in</dt><dd>{live ? <Countdown to={s.expiresAt} /> : <RelativeTime value={s.stoppedAt} />}</dd></div>
            <div><dt className="text-fg-subtle">Driver</dt><dd className="flex items-center gap-1.5">{s.driver ?? '—'} {s.driver && <Badge tone={s.isolated ? 'success' : 'warning'}>{s.isolated ? 'isolated' : 'not isolated'}</Badge>}</dd></div>
            <div><dt className="text-fg-subtle">Commands run</dt><dd>{s.execCount}{s.lastExecAt && <span className="text-fg-muted"> · last <RelativeTime value={s.lastExecAt} /></span>}</dd></div>
            <div><dt className="text-fg-subtle">Env vars</dt><dd className="font-mono">{s.envKeys.length ? s.envKeys.join(', ') : '—'}</dd></div>
            <div><dt className="text-fg-subtle">Created</dt><dd><RelativeTime value={s.createdAt} />{s.fromSnapshotId && <span className="text-fg-muted"> · from {s.fromSnapshotId}</span>}</dd></div>
          </dl>
          {s.error && <p className="mt-3 text-[13px] text-danger">{s.error}</p>}
          <div className="mt-4"><CopyField value={`nav sandbox exec ${s.id} -- echo hello`} /></div>
        </CardBody>
      </Card>
      {!live ? (
        <Empty compact title={`This sandbox is ${s.status}`} description="Its files are gone. Snapshots taken from it can start a new sandbox." />
      ) : !canWrite ? (
        <Empty compact title="Developers only" description="Running commands and moving files requires the developer role or higher." />
      ) : (
        <div>
          <Tabs<TabValue> label="Sandbox" value={tab} onChange={setTab} items={[{ value: 'console', label: 'Console' }, { value: 'files', label: 'Files' }, { value: 'snapshots', label: 'Snapshots' }]} className="mb-4" />
          {tab === 'console' && <SandboxConsole sandbox={s} />}
          {tab === 'files' && <FileBrowser sandbox={s} />}
          {tab === 'snapshots' && <SnapshotsTab sandbox={s} />}
        </div>
      )}
    </div>
  );
}
