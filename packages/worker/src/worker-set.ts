import { NornConfigError } from '@norn-ts/core';

/** The part of a Temporal `Worker` the set drives. */
export interface RunnableWorker {
  run(): Promise<void>;
  shutdown(): void;
  getState(): string;
}

export type WorkerSetState = 'INITIALIZED' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface WorkerSet {
  readonly state: WorkerSetState;
  /** Runs every worker until shutdown, or until one fails (which stops the others). Cleans up once at the end. */
  run(): Promise<void>;
  /** Stops a running set gracefully, or cleans up a set that never ran. */
  shutdown(): Promise<void>;
}

interface Log {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Runs several workers as one: shared state, one failure stops all, and `cleanup` runs exactly once. */
export function workerSet(workers: readonly RunnableWorker[], cleanup: () => Promise<void>, log: Log, meta: Record<string, unknown> = {}): WorkerSet {
  let state: WorkerSetState = 'INITIALIZED';
  let runPromise: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    if (state === 'STOPPED' || state === 'FAILED') return;
    if (state === 'INITIALIZED') {
      state = 'STOPPED';
      await cleanup();
      return;
    }
    if (state === 'RUNNING') {
      state = 'STOPPING';
      for (const w of workers) if (w.getState() === 'RUNNING') w.shutdown();
    }
    await runPromise?.catch(() => undefined);
  };

  const run = (): Promise<void> => {
    if (runPromise) return runPromise;
    if (state !== 'INITIALIZED') return Promise.reject(new NornConfigError(`Cannot run a worker that is ${state}`));
    state = 'RUNNING';
    log.info('Norn worker started', meta);
    runPromise = (async () => {
      const results = await Promise.allSettled(
        workers.map(async (w) => {
          try {
            await w.run();
          } catch (error) {
            // One failed worker stops the others, so the process exits and gets restarted.
            for (const other of workers) if (other !== w && other.getState() === 'RUNNING') other.shutdown();
            throw error;
          }
        }),
      );
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      state = failure ? 'FAILED' : 'STOPPED';
      await cleanup();
      if (failure) throw failure.reason;
      log.info('Norn worker stopped');
    })();
    return runPromise;
  };

  return {
    get state() {
      return state;
    },
    run,
    shutdown,
  };
}
