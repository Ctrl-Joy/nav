// The node's sandboxes: creates and destroys them through the driver, runs commands with output limits and
// timeouts, and moves /workspace in and out of the artifact store for snapshots.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { downloadArtifact, uploadArtifact, type StoredArtifact } from '@nav/shared/artifacts';
import { config } from '@nav/shared/config';
import { SANDBOX_LIMITS, type SandboxExecResult, type SandboxFileEntry } from '@nav/shared';
import type { SandboxBox, SandboxDriver, SandboxProcess, SandboxSpec, StartOptions } from './types.ts';

export class SandboxError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ExecInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  stdin?: string | null;
  maxOutputBytes?: number;
}

/** Keeps the first `max` bytes of a stream and counts the rest. */
function capture(max: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (kept >= max) { truncated = true; return; }
      const take = chunk.length > max - kept ? chunk.subarray(0, max - kept) : chunk;
      if (take.length < chunk.length) truncated = true;
      chunks.push(take);
      kept += take.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    get truncated() { return truncated; },
  };
}

/** Feeds stdin, enforces the timeout (killing the whole process tree) and collects capped output. */
export async function collect(proc: SandboxProcess, opts: { timeoutMs: number; maxOutputBytes: number; stdin?: string | null }): Promise<SandboxExecResult> {
  const started = Date.now();
  const out = capture(opts.maxOutputBytes);
  const err = capture(opts.maxOutputBytes);
  proc.onStdout((c) => out.push(c));
  proc.onStderr((c) => err.push(c));
  if (opts.stdin) proc.write(Buffer.from(opts.stdin, 'utf8'));
  proc.end();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void proc.kill(); }, opts.timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode: timedOut ? null : code,
    stdout: out.text(),
    stderr: err.text(),
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    timedOut,
    durationMs: Date.now() - started,
  };
}

interface Entry { box: SandboxBox; procs: Set<SandboxProcess>; destroying: boolean }

export class SandboxManager {
  readonly driver: SandboxDriver;
  /** Null when sandboxes may run here; otherwise why they may not. */
  readonly disabledReason: string | null;
  private boxes = new Map<string, Entry>();
  private creating = new Set<string>();

  constructor(driver: SandboxDriver, disabledReason: string | null = null) {
    this.driver = driver;
    this.disabledReason = disabledReason;
  }

  ids(): string[] {
    return [...this.boxes.keys()];
  }

  private entry(id: string): Entry {
    const e = this.boxes.get(id);
    if (!e || e.destroying) throw new SandboxError(404, 'sandbox is not running on this node');
    return e;
  }

  async create(spec: SandboxSpec, snapshot: StoredArtifact | null): Promise<{ ref: string; driver: string; isolated: boolean }> {
    if (this.disabledReason) throw new SandboxError(503, this.disabledReason);
    if (this.boxes.has(spec.id) || this.creating.has(spec.id)) throw new SandboxError(409, 'sandbox already exists on this node');
    this.creating.add(spec.id);
    try {
      const box = await this.driver.create(spec);
      try {
        if (snapshot) await this.restore(box, snapshot);
      } catch (err) {
        await box.destroy().catch(() => {});
        throw err;
      }
      this.boxes.set(spec.id, { box, procs: new Set(), destroying: false });
      return { ref: box.ref, driver: this.driver.name, isolated: this.driver.isolated };
    } finally {
      this.creating.delete(spec.id);
    }
  }

  /** Re-attaches to a sandbox that survived an agent restart. */
  async adopt(id: string): Promise<boolean> {
    const box = await this.driver.adopt?.(id);
    if (!box) return false;
    this.boxes.set(id, { box, procs: new Set(), destroying: false });
    return true;
  }

  /** Idempotent: kills every running command, then removes the sandbox and its files. */
  async destroy(id: string): Promise<void> {
    const e = this.boxes.get(id);
    if (!e || e.destroying) return;
    e.destroying = true;
    await Promise.all([...e.procs].map((p) => p.kill().catch(() => {})));
    await e.box.destroy();
    this.boxes.delete(id);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(this.ids().map((id) => this.destroy(id).catch(() => {})));
  }

  /** Starts a command (or a shell) and tracks it, so a delete or expiry kills it. */
  async start(id: string, opts: StartOptions): Promise<SandboxProcess> {
    const e = this.entry(id);
    if (e.procs.size >= SANDBOX_LIMITS.maxConcurrentExecs) throw new SandboxError(429, `at most ${SANDBOX_LIMITS.maxConcurrentExecs} commands may run at once in a sandbox`);
    const proc = await e.box.start(opts);
    e.procs.add(proc);
    void proc.exited.then(() => e.procs.delete(proc));
    return proc;
  }

  async exec(id: string, input: ExecInput): Promise<SandboxExecResult> {
    const timeout = Math.min(SANDBOX_LIMITS.maxExecTimeoutSeconds, Math.max(1, input.timeoutSeconds ?? SANDBOX_LIMITS.defaultExecTimeoutSeconds));
    const proc = await this.start(id, { command: input.command, cwd: input.cwd ?? '', env: input.env ?? {}, tty: false, cols: 120, rows: 32 });
    return collect(proc, {
      timeoutMs: timeout * 1000,
      maxOutputBytes: Math.min(SANDBOX_LIMITS.maxOutputBytes, input.maxOutputBytes ?? SANDBOX_LIMITS.maxOutputBytes),
      stdin: input.stdin,
    });
  }

  writeFile(id: string, rel: string, data: Buffer, mode?: number) {
    if (data.length > SANDBOX_LIMITS.maxFileBytes) throw new SandboxError(413, 'file is too large');
    return this.entry(id).box.writeFile(rel, data, mode);
  }

  readFile(id: string, rel: string) {
    return this.entry(id).box.readFile(rel);
  }

  list(id: string, rel: string): Promise<SandboxFileEntry[]> {
    return this.entry(id).box.list(rel);
  }

  remove(id: string, rel: string, recursive: boolean) {
    return this.entry(id).box.remove(rel, recursive);
  }

  /** Archives /workspace into the artifact store under `key`. */
  async snapshot(id: string, key: string): Promise<StoredArtifact> {
    const box = this.entry(id).box;
    return uploadArtifact(key, (await box.archive()).pipe(createGzip({ level: 6 })));
  }

  private async restore(box: SandboxBox, store: StoredArtifact): Promise<void> {
    const dir = path.join(config.dataDir, 'tmp');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${store.key}.${randomBytes(4).toString('hex')}.tgz`);
    try {
      await downloadArtifact(store, file);
      await box.restore(createReadStream(file).pipe(createGunzip()));
    } finally {
      await rm(file, { force: true });
    }
  }
}
