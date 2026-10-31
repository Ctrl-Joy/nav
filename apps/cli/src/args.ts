import { parseArgs as nodeParseArgs, type ParseArgsConfig } from 'node:util';
import { UsageError } from './errors.ts';

export interface OptionSpec {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
}

export type OptionMap = Record<string, OptionSpec>;

// Parsed command arguments with typed accessors.
export class ParsedArgs {
  readonly positionals: string[];
  private readonly values: Record<string, unknown>;

  constructor(positionals: string[], values: Record<string, unknown>) {
    this.positionals = positionals;
    this.values = values;
  }

  str(name: string): string | undefined {
    const value = this.values[name];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.length > 0 ? String(value[value.length - 1]) : undefined;
    return String(value);
  }

  strs(name: string): string[] {
    const value = this.values[name];
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(String);
  }

  bool(name: string): boolean {
    return this.values[name] === true;
  }

  int(name: string): number | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number, got "${raw}"`);
    return Number(raw);
  }

  arg(index: number, label: string, usage: string): string {
    const value = this.positionals[index];
    if (value === undefined || value === '') throw new UsageError(`missing ${label}`, `usage: ${usage}`);
    return value;
  }

  maxPositionals(max: number, usage: string): void {
    if (this.positionals.length > max) {
      throw new UsageError(`unexpected argument "${this.positionals[max]}"`, `usage: ${usage}`);
    }
  }
}

const COMMON_OPTIONS: OptionMap = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// Every command accepts --json and --help. Unknown flags are errors.
export function parseCommandArgs(argv: string[], options: OptionMap = {}): ParsedArgs {
  const spec: OptionMap = { ...COMMON_OPTIONS, ...options };
  try {
    const parsed = nodeParseArgs({
      args: argv,
      options: spec as ParseArgsConfig['options'],
      allowPositionals: true,
      strict: true,
    });
    return new ParsedArgs(parsed.positionals, parsed.values as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(message.split('. ')[0] ?? message);
  }
}

// Checks a flag value against an allowed list. Returns the value, or throws.
export function pick(flag: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}`, `got "${value}"`);
  }
  return value;
}

export function requireFlag(flag: string, value: string | undefined, usage: string): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required`, `usage: ${usage}`);
  return value;
}
