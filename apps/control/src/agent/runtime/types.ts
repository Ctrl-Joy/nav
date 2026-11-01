import type { Plan, SecretFile, Disk } from '@nav/shared';
import type { StoredArtifact } from '@nav/shared/artifacts';

/** `nodeId` is the node that built it; `store` is set once it has been uploaded for other nodes to fetch. */
interface Placed { nodeId?: string; store?: StoredArtifact; registryCredentialId?: string }

export interface RegistryAuth { serveraddress: string; username: string; password: string }

export type Artifact =
  | ({ kind: 'dir'; root: string; path: string; runtime: string; startCommand: string | null } & Placed)
  | ({ kind: 'image'; ref: string; startCommand: string | null } & Placed);

export interface BuildContext {
  deployId: string;
  serviceId: string;
  workspaceId: string;
  srcDir: string;            // checked-out repository
  appDir: string;            // srcDir + rootDir
  service: Record<string, any>;
  env: Record<string, string>;
  clearCache: boolean;
  log: (line: string) => void;
  signal: AbortSignal;
}

export interface StartSpec {
  instanceId: string;
  serviceId: string;
  workspaceId: string;
  slug: string;
  artifact: Artifact;
  command: string | null;    // overrides the artifact's start command (jobs, pre-deploy)
  env: Record<string, string>;
  files: SecretFile[];
  containerPort: number | null;
  plan: Plan;
  disk: Disk | null;
  oneOff: boolean;           // job/cron/pre-deploy: no port, runs to completion
  onLog: (line: string, level?: string) => void;
}

export interface Handle {
  ref: string;               // pid or container id
  host: string;
  port: number | null;       // host-reachable port
  exited: Promise<number>;   // resolves with exit code
  stop(graceMs: number): Promise<void>;
}

export interface Usage { cpu: number; memBytes: number }

/** An interactive shell inside a running instance. `tty` is false when only pipes are available (process driver). */
export interface ExecSession {
  tty: boolean;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Buffer) => void): void;
  exited: Promise<number>;
  kill(): void;
}

export interface ExecOptions { cwd: string | null; env: Record<string, string>; cols: number; rows: number }

export interface Driver {
  name: 'process' | 'docker';
  build(ctx: BuildContext, detected: { runtime: string; buildCommand: string | null; startCommand: string | null }): Promise<Artifact>;
  pullImage?(imageUrl: string, log: (l: string) => void, auth?: RegistryAuth): Promise<Artifact>;
  start(spec: StartSpec): Promise<Handle>;
  /** Re-attach to instances that survived an agent restart (docker). */
  adopt?(ref: string, onLog: (line: string) => void): Promise<Handle | null>;
  usage(refs: string[]): Promise<Map<string, Usage>>;
  removeArtifact(artifact: Artifact): Promise<void>;
  /** Image transport between nodes (docker). */
  hasImage?(ref: string): Promise<boolean>;
  saveImage?(ref: string): Promise<NodeJS.ReadableStream>;
  loadImage?(tar: NodeJS.ReadableStream): Promise<void>;
  removeServiceData?(serviceId: string): Promise<void>;
  /** Opens a shell in the instance identified by its handle ref (container id or pid). */
  exec?(ref: string, opts: ExecOptions): Promise<ExecSession>;
}
