import type { Plan, SecretFile, Disk } from '@nav/shared';

export type Artifact =
  | { kind: 'dir'; root: string; path: string; runtime: string; startCommand: string | null }
  | { kind: 'image'; ref: string; startCommand: string | null };

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

export interface Driver {
  name: 'process' | 'docker';
  build(ctx: BuildContext, detected: { runtime: string; buildCommand: string | null; startCommand: string | null }): Promise<Artifact>;
  pullImage?(imageUrl: string, log: (l: string) => void): Promise<Artifact>;
  start(spec: StartSpec): Promise<Handle>;
  /** Re-attach to instances that survived an agent restart (docker). */
  adopt?(ref: string, onLog: (line: string) => void): Promise<Handle | null>;
  usage(refs: string[]): Promise<Map<string, Usage>>;
  removeArtifact(artifact: Artifact): Promise<void>;
  removeServiceData?(serviceId: string): Promise<void>;
}
