// Types for the NAV Workflows SDK (index.js).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TaskOptions {
  /** Extra attempts after a failure (0-20, default 0). Each attempt replays recorded subtask results. */
  retries?: number;
  /** Limit for each execution of the task code, in seconds (default 3600). Waiting on subtasks or sleeps does not count. */
  timeoutSeconds?: number;
  /** Delay before the first retry; doubles on each further retry (default 5). */
  backoffSeconds?: number;
  /** Upper bound for the retry delay (default 600). */
  maxBackoffSeconds?: number;
  description?: string;
}

export interface ResolvedTaskOptions {
  retries: number;
  timeoutSeconds: number;
  backoffSeconds: number;
  maxBackoffSeconds: number;
  description: string | null;
}

export interface TaskHandle<I = any, O = any> {
  readonly name: string;
  readonly options: Readonly<ResolvedTaskOptions>;
  /** Phantom marker for input/output inference; never set at runtime. */
  readonly __types?: { input: I; output: O };
}

export interface TaskContext {
  readonly runId: string | null;
  readonly task: string;
  /** 1 for the first attempt, incremented on each retry. */
  readonly attempt: number;
  /** Runs a subtask as a child run and resolves with its output; rejects with TaskRunError if it fails. */
  run<I, O>(task: TaskHandle<I, O>, input: I): Promise<Awaited<O>>;
  run<O = any>(task: string, input?: unknown): Promise<O>;
  /** Durable sleep: the run waits without holding a process. */
  sleep(ms: number): Promise<void>;
}

export type TaskFn<I, O> = (input: I, ctx: TaskContext) => O | Promise<O>;

export function task<I = any, O = any>(name: string, fn: TaskFn<I, O>): TaskHandle<I, O>;
export function task<I = any, O = any>(name: string, options: TaskOptions, fn: TaskFn<I, O>): TaskHandle<I, O>;

export interface StepRecord {
  seq: number;
  kind: 'run' | 'sleep';
  task?: string;
  runId?: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'pending';
  output?: Json;
  error?: { name?: string; message: string } | null;
}

export interface Invocation {
  task: string;
  input?: unknown;
  runId?: string;
  attempt?: number;
  steps?: StepRecord[];
}

export interface SerializedError { name: string; message: string; stack: string | null }

export type StepRequest = { seq: number; kind: 'run'; task: string; input: Json } | { seq: number; kind: 'sleep'; ms: number };

export type ExecutionResult =
  | { status: 'succeeded'; output: Json }
  | { status: 'failed'; error: SerializedError; retryable: boolean }
  | { status: 'suspended'; steps: StepRequest[] };

export interface Description {
  status: 'described';
  sdk: { language: 'javascript'; version: string };
  tasks: (ResolvedTaskOptions & { name: string })[];
}

export const SDK_VERSION: string;
export const INVOCATION_FILE: string;

export function describe(): Description;
export function execute(invocation: Invocation): Promise<ExecutionResult>;
export function encodeResult(result: ExecutionResult | Description): string;
export function start(): Promise<void>;

export class NonRetryableError extends Error {
  readonly retryable: false;
  constructor(message?: string, options?: { cause?: unknown });
}
export class TaskRunError extends Error {
  readonly task: string;
  readonly runId: string | null;
  readonly status: 'failed' | 'canceled';
}
export class NonDeterminismError extends Error {
  readonly retryable: false;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  task: string;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';
  input: Json;
  output: Json;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  parentRunId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  [key: string]: unknown;
}

export interface Client {
  runTask(workflow: string, task: string, input?: unknown, options?: { idempotencyKey?: string }): Promise<WorkflowRun>;
  getRun(runId: string): Promise<WorkflowRun>;
  cancelRun(runId: string): Promise<unknown>;
  waitForRun(runId: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<WorkflowRun>;
}

export function createClient(options?: { apiUrl?: string; token?: string }): Client;
export function runTask(workflow: string, task: string, input?: unknown, options?: { idempotencyKey?: string }): Promise<WorkflowRun>;
