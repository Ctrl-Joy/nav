import type { Readable } from 'node:stream';
import type { SandboxFileEntry, SandboxNetworkAccess, SandboxPlan, SandboxRuntime } from '@nav/shared';

export interface SandboxSpec {
  id: string;
  workspaceId: string;
  image: string;
  runtime: SandboxRuntime | null;
  plan: SandboxPlan;
  /** The caller's variables only: platform settings and secrets are never added. */
  env: Record<string, string>;
  networkAccess: SandboxNetworkAccess;
}

/** One command (or interactive shell) running inside a sandbox. */
export interface SandboxProcess {
  tty: boolean;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  write(data: Buffer): void;
  end(): void;
  resize(cols: number, rows: number): void;
  /** Kills the command and everything it started. */
  kill(): Promise<void>;
  /** Exit code; null when it was killed by a signal. */
  exited: Promise<number | null>;
}

export interface StartOptions {
  /** Null opens an interactive shell. */
  command: string | null;
  /** Relative to /workspace. */
  cwd: string;
  env: Record<string, string>;
  tty: boolean;
  cols: number;
  rows: number;
}

/** A sandbox's live handle on the node that runs it. */
export interface SandboxBox {
  id: string;
  /** Container id (docker) or the sandbox directory (process). */
  ref: string;
  start(opts: StartOptions): Promise<SandboxProcess>;
  writeFile(rel: string, data: Buffer, mode?: number): Promise<{ size: number }>;
  readFile(rel: string): Promise<{ stream: Readable; size: number }>;
  list(rel: string): Promise<SandboxFileEntry[]>;
  remove(rel: string, recursive: boolean): Promise<void>;
  /** Tar of /workspace, entries relative to it. */
  archive(): Promise<Readable>;
  /** Extracts a tar (entries relative to /workspace) into /workspace. */
  restore(tar: Readable): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxDriver {
  name: 'process' | 'docker';
  /** False for the process driver: commands run as ordinary host processes. */
  isolated: boolean;
  create(spec: SandboxSpec): Promise<SandboxBox>;
  /** Re-attaches to a sandbox that survived an agent restart (docker). */
  adopt?(id: string): Promise<SandboxBox | null>;
  /** Removes leftovers of sandboxes this node no longer tracks. */
  sweep?(keep: Set<string>): Promise<void>;
}
