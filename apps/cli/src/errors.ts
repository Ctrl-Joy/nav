// Error types. Anything thrown from a command is printed as `error: <message>` (plus an optional hint).

export class CliError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}

// Bad arguments or flags; the user needs to fix the command line.
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'UsageError';
  }
}

// Non-2xx response from the NAV API, using the {error:{code,message}} shape.
export class ApiError extends CliError {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
