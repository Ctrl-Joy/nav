import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RotateCw, SquareTerminal } from 'lucide-react';
import { useInstances } from '@/api/services';
import { Button, Empty, Select, StatusDot, type Tone } from '@/components/ui';
import { useWorkspace } from '@/layouts/WorkspaceContext';
import { useServiceCtx } from './context';

type ShellState =
  | { kind: 'connecting' }
  | { kind: 'ready'; tty: boolean; instanceId: string; driver: string }
  | { kind: 'exited'; code: number | null }
  | { kind: 'closed'; message: string };

const STATE_TONE: Record<ShellState['kind'], Tone> = { connecting: 'warning', ready: 'success', exited: 'neutral', closed: 'danger' };

function shellUrl(serviceId: string, cols: number, rows: number, instance: string): string {
  const qs = new URLSearchParams({ cols: String(cols), rows: String(rows) });
  if (instance) qs.set('instance', instance);
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/services/${serviceId}/shell?${qs}`;
}

export function ServiceShellTab() {
  const { service } = useServiceCtx();
  const { canWrite } = useWorkspace();
  const instances = useInstances(service.id);
  const healthy = (instances.data?.items ?? []).filter((i) => i.status === 'healthy');
  const [instance, setInstance] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ShellState>({ kind: 'connecting' });
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !canWrite || service.suspended) return;
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

    const ws = new WebSocket(shellUrl(service.id, term.cols, term.rows, instance));
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    let tty = true;
    let ready = false;
    let finished = false;
    // Without a TTY (process driver) the terminal edits and echoes the line itself.
    let line = '';

    const send = (text: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(text));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let msg: { type?: string; tty?: boolean; instanceId?: string; driver?: string; code?: number; message?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        term.write(ev.data);
        return;
      }
      if (msg.type === 'ready') {
        ready = true;
        tty = msg.tty !== false;
        term.options.convertEol = !tty;
        setState({ kind: 'ready', tty, instanceId: msg.instanceId ?? '', driver: msg.driver ?? '' });
        if (!tty) term.write('\x1b[2mNo TTY on this instance: lines are sent when you press Enter.\x1b[0m\r\n');
        term.focus();
      } else if (msg.type === 'exit') {
        finished = true;
        term.write(`\r\n\x1b[2mProcess exited with code ${msg.code ?? '?'}.\x1b[0m\r\n`);
        setState({ kind: 'exited', code: msg.code ?? null });
      } else if (msg.type === 'error') {
        finished = true;
        term.write(`\r\n\x1b[31m${msg.message ?? 'Shell error'}\x1b[0m\r\n`);
        setState({ kind: 'closed', message: msg.message ?? 'Shell error' });
      }
    };
    ws.onclose = () => {
      if (finished) return;
      // The control plane rejects the upgrade with an HTTP status the browser does not expose.
      const message = ready ? 'Connection closed.' : 'Could not open a shell. The instance may have stopped, or the node does not offer shell access.';
      term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
      setState({ kind: 'closed', message });
    };

    const onData = term.onData((data) => {
      if (!ready) return;
      if (tty) return send(data);
      if (data.startsWith('\x1b')) return; // arrow keys etc.: no history or cursor movement
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
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
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
  }, [service.id, service.suspended, instance, attempt, canWrite]);

  if (!canWrite) return <Empty title="Developers only" description="Opening a shell requires the developer role or higher." />;
  if (service.suspended) return <Empty icon={<SquareTerminal />} title="Service is suspended" description="Resume the service to open a shell on one of its instances." />;

  const label =
    state.kind === 'connecting'
      ? 'Connecting…'
      : state.kind === 'ready'
        ? `Connected to ${state.instanceId.slice(-8) || 'instance'}${state.driver ? ` · ${state.driver}` : ''}${state.tty ? '' : ' · line mode'}`
        : state.kind === 'exited'
          ? `Exited${state.code != null ? ` (code ${state.code})` : ''}`
          : state.message;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-full sm:w-72"
          aria-label="Instance"
          value={instance}
          onChange={(e) => setInstance(e.target.value)}
          placeholder="Any healthy instance"
          options={healthy.map((i) => ({ value: i.id, label: `${i.id.slice(-8)} · node ${i.nodeId.slice(-6)}` }))}
        />
        <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => setAttempt((n) => n + 1)}>
          Reconnect
        </Button>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-[13px] text-fg-muted" role="status">
          <StatusDot tone={STATE_TONE[state.kind]} pulse={state.kind === 'connecting'} />
          <span className="truncate">{label}</span>
        </span>
      </div>
      <div className="overflow-hidden rounded-[3px] border border-border-strong bg-[#0a0a0a] p-2">
        <div ref={host} className="h-[min(560px,65dvh)] w-full" aria-label="Instance shell" />
      </div>
      <p className="text-xs text-fg-subtle">Shell sessions run inside the instance and are recorded in the workspace audit log. Changes to the filesystem are lost on the next deploy unless written to a disk.</p>
    </div>
  );
}
