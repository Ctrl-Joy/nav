import type { CommandDef } from './command.ts';
import { commands } from './commands/index.ts';
import { ApiError, CliError, UsageError, errorMessage } from './errors.ts';
import { dim, err, out, padCell, paint } from './output.ts';
import { VERSION } from './version.ts';

const registry = new Map<string, CommandDef>(commands.map((command) => [command.name, command]));

function mainHelp(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = [
    'nav - command-line client for NAV',
    '',
    'Usage: nav <command> [arguments] [options]',
    '',
    'Commands:',
    ...commands.map((c) => `  ${padCell(c.name, width)}  ${c.summary}`),
    '',
    'Other: nav help <command>, nav --version',
    '',
    'Global options: --json (machine-readable output), --help',
    'Environment: NAV_HOST, NAV_TOKEN, NAV_WORKSPACE override ~/.nav/config.json; NO_COLOR disables color.',
  ];
  return lines.join('\n');
}

function commandHelp(command: CommandDef): string {
  return [
    'Usage:',
    ...command.usage.map((line) => `  ${line}`),
    '',
    `${command.summary}.`,
  ].join('\n');
}

function helpFor(name: string | undefined): void {
  if (name === undefined) {
    out(mainHelp());
    return;
  }
  const command = registry.get(name);
  if (!command) throw new UsageError(`no help for unknown command "${name}"`, 'run nav help to list commands');
  out(commandHelp(command));
}

function reportError(error: unknown): void {
  let hint: string | undefined;
  if (error instanceof CliError) hint = error.hint;
  if (error instanceof ApiError && error.status === 401) {
    hint = 'the API token is missing or no longer valid; run nav login';
  }
  err(paint(`error: ${errorMessage(error)}`, 'red', process.stderr));
  if (hint) err(dim(`hint: ${hint}`));
  if (process.env.NAV_DEBUG && error instanceof Error && error.stack) err(error.stack);
}

// Runs one CLI invocation. Errors are reported on stderr and set exit code 1; commands may set
// process.exitCode themselves (for example deploy --wait when the deploy fails).
export async function run(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  try {
    if (name === undefined || name === '--help' || name === '-h') {
      out(mainHelp());
      return;
    }
    if (name === '--version' || name === '-v' || name === 'version') {
      out(`nav ${VERSION}`);
      return;
    }
    if (name === 'help') {
      helpFor(rest[0]);
      return;
    }
    const command = registry.get(name);
    if (!command) {
      throw new UsageError(`unknown command "${name}"`, 'run nav help to see the available commands');
    }
    const separator = rest.indexOf('--');
    const beforeSeparator = separator === -1 ? rest : rest.slice(0, separator);
    if (beforeSeparator.includes('--help') || beforeSeparator.includes('-h')) {
      out(commandHelp(command));
      return;
    }
    await command.run(rest);
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
}

await run(process.argv.slice(2));
