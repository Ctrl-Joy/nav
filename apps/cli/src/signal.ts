export interface Interrupt {
  signal: AbortSignal;
  dispose: () => void;
}

// The first Ctrl+C aborts the returned signal so streams can wind down. A second one exits.
export function trapInterrupt(): Interrupt {
  const controller = new AbortController();
  const onSigint = (): void => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSigint);
    },
  };
}

// Resolves after ms, or early when the signal aborts. Never rejects.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
