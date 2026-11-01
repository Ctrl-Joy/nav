// `nav ssh <service>`: an interactive shell inside a running instance, relayed by the control plane.
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext } from '../context.ts';
import { CliError } from '../errors.ts';

const USAGE = 'nav ssh <service> [--instance <id>]';

async function ssh(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, { instance: { type: 'string' } });
  const ref = args.arg(0, 'service', USAGE);
  args.maxPositionals(1, USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 32;
  const qs = new URLSearchParams({ cols: String(cols), rows: String(rows), ...(args.str('instance') ? { instance: args.str('instance')! } : {}) });
  const url = `${ctx.config.host.replace(/^http/, 'ws')}/api/v1/services/${svc.id}/shell?${qs}`;
  // Node's WebSocket (undici) accepts headers as a non-standard option.
  const WS = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket;
  const sock = new WS(url, { headers: { authorization: `Bearer ${ctx.config.token}` } });
  sock.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    let tty = true;
    const restore = () => { if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause(); };
    sock.addEventListener('open', () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (d: Buffer) => sock.send(d));
      process.stdout.on('resize', () => sock.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows })));
    });
    sock.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'ready') {
          tty = m.tty;
          // Without a TTY on the far side, let the local terminal echo and edit lines.
          if (!tty && process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stderr.write(`Connected to ${svc.name} (${m.instanceId})${tty ? '' : ' — line mode'}\r\n`);
        } else if (m.type === 'error') {
          restore();
          reject(new CliError(m.message));
        }
        return;
      }
      process.stdout.write(Buffer.from(e.data as ArrayBuffer));
    });
    sock.addEventListener('close', (e) => { restore(); if (e.code !== 1000 && e.code !== 1005 && e.reason) process.stderr.write(`\r\nDisconnected: ${e.reason}\r\n`); resolve(); });
    sock.addEventListener('error', () => { restore(); reject(new CliError('could not open a shell', 'is the service running, and do you have developer access?')); });
  });
}

export const sshCommands: CommandDef[] = [{ name: 'ssh', summary: 'Open a shell in a running instance', usage: [USAGE], run: ssh }];
