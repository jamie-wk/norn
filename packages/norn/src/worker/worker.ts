import { NativeConnection, Runtime, Worker, type WorkerOptions, type WorkerPlugin } from '@temporalio/worker';
import { NornConfigError, TemporalUnavailableError } from '../core/index.js';
import { bundleEntry } from './bundle.js';
import { resolveWorkerConfig, type ResolvedWorkerConfig, type WorkerConfigOptions } from './config.js';
import { activityFunctions, loadWorkflows, writeEntry } from './load.js';

export type NornWorkerState = 'INITIALIZED' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface CreateWorkerOptions extends WorkerConfigOptions {
  /** A module exporting your `@Workflow` classes, e.g. `new URL('./workflows/index.ts', import.meta.url)`. */
  workflows?: string | URL;
  /** Activity objects by namespace: `{ payments: new PaymentActivities(gateway) }` registers `payments.<method>`. */
  activities?: Readonly<Record<string, object>>;
  /** Task queues to poll. Defaults to every queue the workflows declare; required for an activity-only worker. */
  taskQueues?: readonly string[];
  /** An existing connection, e.g. from a test environment. Otherwise Norn connects and closes it. */
  connection?: NativeConnection;
  /** A prebuilt bundle from `bundleWorkflows()`. Defaults to the file in `NORN_WORKFLOW_BUNDLE`, else bundling `workflows` at startup. */
  workflowBundle?: { code: string } | { codePath: string };
  /** A custom data converter, e.g. one that encrypts payloads. */
  dataConverter?: WorkerOptions['dataConverter'];
  plugins?: WorkerPlugin[];
  /** Passed through to every Temporal `Worker.create()` call. */
  workerOptions?: Omit<
    Partial<WorkerOptions>,
    'connection' | 'namespace' | 'taskQueue' | 'activities' | 'workflowBundle' | 'workflowsPath' | 'dataConverter' | 'plugins' | 'bundlerOptions'
  >;
}

export interface NornWorker extends AsyncDisposable {
  readonly taskQueues: readonly string[];
  readonly state: NornWorkerState;
  readonly config: ResolvedWorkerConfig;
  /** Polls every task queue until shutdown. Resolves once workers drained and resources closed. */
  run(): Promise<void>;
  /** Starts a graceful shutdown: stop polling, let in-flight tasks finish within the grace time. */
  shutdown(): Promise<void>;
}

function unavailable(address: string, error: unknown): TemporalUnavailableError {
  return new TemporalUnavailableError({ message: `Could not connect to Temporal at ${address}: ${(error as Error).message}`, cause: error });
}

/** A Temporal worker that was created but never run holds its threads until run() ends, so run and stop it. */
async function releaseUnrun(workers: readonly Worker[]): Promise<void> {
  for (const w of workers) {
    if (w.getState() !== 'INITIALIZED') continue;
    const running = w.run();
    w.shutdown();
    await running.catch(() => undefined);
  }
}

/**
 * Creates a worker for your workflows and activities: one Temporal worker per task queue, graceful
 * shutdown on SIGTERM / SIGINT, and Norn's error types for connection failures.
 */
export async function createWorker(options: CreateWorkerOptions): Promise<NornWorker> {
  const config = resolveWorkerConfig(options);
  if (options.workflows === undefined && options.taskQueues === undefined) {
    throw new NornConfigError('createWorker() needs `workflows`, or `taskQueues` for an activity-only worker');
  }
  const loaded = options.workflows === undefined ? undefined : await loadWorkflows(options.workflows);
  const taskQueues = [...(options.taskQueues ?? loaded!.taskQueues)];
  if (taskQueues.length === 0) throw new NornConfigError('A worker needs at least one task queue');
  const activities = activityFunctions(options.activities ?? {});
  const log = Runtime.instance().logger;

  let connection: NativeConnection | undefined;
  const cleanups: Array<() => Promise<void>> = [];
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const fn of cleanups.splice(0).toReversed()) {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) log.warn('Norn worker cleanup failed', { errors: errors.map(String) });
  };

  let workers: Worker[];
  try {
    if (options.connection) {
      connection = options.connection;
    } else {
      try {
        connection = await NativeConnection.connect({
          address: config.address,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.tls ? { tls: true } : {}),
        });
      } catch (error) {
        throw unavailable(config.address, error);
      }
      const owned = connection;
      cleanups.push(() => owned.close());
    }

    const payloadConverterPath = (options.dataConverter as { payloadConverterPath?: string } | undefined)?.payloadConverterPath;
    // Only a worker with workflows takes the env bundle: an activity-only worker must not start running workflows.
    const prebuilt = loaded && process.env.NORN_WORKFLOW_BUNDLE ? { codePath: process.env.NORN_WORKFLOW_BUNDLE } : undefined;
    const workflowBundle =
      options.workflowBundle ??
      prebuilt ??
      (loaded ? await bundleEntry(await writeEntry(loaded.path), { payloadConverterPath, plugins: options.plugins }) : undefined);

    const create = (taskQueue: string) =>
      Worker.create({
        ...options.workerOptions,
        connection: connection!,
        namespace: config.namespace,
        taskQueue,
        ...(workflowBundle ? { workflowBundle } : {}),
        activities,
        dataConverter: options.dataConverter,
        plugins: options.plugins,
        shutdownGraceTime: config.shutdownGraceTime,
      });
    try {
      const created = await Promise.allSettled(taskQueues.map(create));
      workers = created.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      // Registered after the connection, so it runs before the connection closes.
      cleanups.push(() => releaseUnrun(workers));
      const failed = created.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 14 || /unavailable|connect/i.test(String((error as Error).message))) throw unavailable(config.address, error);
      throw error;
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  let state: NornWorkerState = 'INITIALIZED';
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

  const onSignal = (signal: NodeJS.Signals) => {
    log.info(`Norn worker received ${signal}; shutting down gracefully`, { gracePeriod: config.shutdownGraceTime });
    void shutdown();
  };
  if (config.handleSignals) {
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    cleanups.push(async () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    });
  }

  const run = (): Promise<void> => {
    if (runPromise) return runPromise;
    if (state !== 'INITIALIZED') return Promise.reject(new NornConfigError(`Cannot run a worker that is ${state}`));
    state = 'RUNNING';
    log.info('Norn worker started', { taskQueues, namespace: config.namespace });
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
    taskQueues,
    config,
    get state() {
      return state;
    },
    run,
    shutdown,
    async [Symbol.asyncDispose]() {
      await shutdown();
    },
  };
}
