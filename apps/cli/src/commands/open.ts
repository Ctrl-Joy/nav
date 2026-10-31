import { spawn } from 'node:child_process';
import { parseCommandArgs } from '../args.ts';
import type { CommandDef } from '../command.ts';
import { findService, workspaceContext } from '../context.ts';
import { CliError, UsageError } from '../errors.ts';
import { out } from '../output.ts';

const USAGE = 'nav open <service>';

export interface OpenCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// Builds the platform command that opens a URL in the default browser.
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): OpenCommand {
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#\[\]@%+=,-]+$/.test(url)) {
    throw new UsageError(`refusing to open unexpected URL: ${url}`);
  }
  if (platform === 'win32') {
    // "start" is a cmd builtin; the empty "" is its window-title argument.
    return { command: 'cmd', args: ['/c', 'start', '""', url], windowsVerbatimArguments: true };
  }
  if (platform === 'darwin') return { command: 'open', args: [url], windowsVerbatimArguments: false };
  return { command: 'xdg-open', args: [url], windowsVerbatimArguments: false };
}

async function openService(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv);
  const ref = args.arg(0, 'service', USAGE);
  args.maxPositionals(1, USAGE);
  const ctx = await workspaceContext();
  const svc = await findService(ctx, ref);
  if (!svc.url) {
    throw new CliError(`${svc.name} has no public URL`, 'only web and static services get a public URL');
  }
  const { command, args: commandArgs, windowsVerbatimArguments } = openCommand(svc.url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments,
    });
    child.once('error', reject);
    child.once('spawn', () => resolve());
    child.unref();
  }).catch(() => {
    throw new CliError(`could not start a browser; open this URL yourself: ${svc.url}`);
  });
  out(`Opening ${svc.url}`);
}

export const openCommands: CommandDef[] = [
  {
    name: 'open',
    summary: 'Open a service\'s public URL in the browser',
    usage: [USAGE],
    run: openService,
  },
];
