import {
  NativeConnection,
  Runtime,
  Worker,
  type WorkerOptions,
  type WorkerPlugin,
} from '@temporalio/worker';
import { NornConfigError, TemporalUnavailableError } from '@norn-ts/core';
import type { Container } from '@norn-ts/activity';
import { correlationActivityInterceptor } from './activity-interceptors.js';
import { bundleWorkflows } from './bundle.js';
import { resolveWorkerConfig, type ResolvedWorkerConfig, type WorkerConfigOptions } from './config.js';
import { startHealthServer, type HealthServer } from './health.js';
import type { RegistryContainerOptions } from './registry.js';

export type NornWorkerState = 'INITIALIZED' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface CreateWorkerOptions extends WorkerConfigOptions {
  /** An existing connection, e.g. from a test environment. Otherwise Norn connects and closes it. */
  connection?: NativeConnection;
  /** Overrides and error mapping for the dependency container. */
  container?: RegistryContainerOptions;
  /**
   * A prebuilt bundle from `bundleWorkflows()` / `norn bundle`. Defaults to the file in
   * `NORN_WORKFLOW_BUNDLE`, otherwise the registry's workflows are bundled at startup.
   */
  workflowBundle?: { code: string } | { codePath: string };
  /** E.g. `createDataConverter()` from `@norn-ts/codec`. */
  dataConverter?: WorkerOptions['dataConverter'];
  plugins?: WorkerPlugin[];
  /** Replace registered activities by name, typically with mocks in tests. Names must exist in the registry. */
  activityOverrides?: Record<string, (...args: any[]) => unknown>;
  /** Passed through to every Temporal `Worker.create()` call. */
  workerOptions?: Omit<
    Partial<WorkerOptions>,
    'connection' | 'namespace' | 'taskQueue' | 'activities' | 'workflowBundle' | 'workflowsPath' | 'dataConverter' | 'plugins' | 'bundlerOptions'
  >;
}

export interface NornWorker extends AsyncDisposable {
  readonly taskQueues: readonly string[];
  readonly state: NornWorkerState;
  /** The health server's port when one is running (useful with `health: { port: 0 }`). */
  readonly healthPort: number | undefined;
  readonly config: ResolvedWorkerConfig;
  /** Polls every task queue until shutdown. Resolves once workers drained and resources closed. */
  run(): Promise<void>;
  /** Starts a graceful shutdown: stop polling, let in-flight tasks finish within the grace time. */
  shutdown(): Promise<void>;
}

function unavailable(address: string, error: unknown): TemporalUnavailableError {
  return new TemporalUnavailableError({ message: `Could not connect to Temporal at ${address}: ${(error as Error).message}`, cause: error });
}

/**
 * A Temporal worker that was created but never run keeps its connection reference and worker
 * threads until its run() ends, so run it and stop it straight away.
 */
async function releaseUnrun(workers: readonly Worker[]): Promise<void> {
  for (const w of workers) {
    if (w.getState() !== 'INITIALIZED') continue;
    const running = w.run();
    w.shutdown();
    await running.catch(() => undefined);
  }
}

/**
 * Creates a production worker from the generated registry: one Temporal worker per task queue,
 * activities built by the dependency container, health checks, graceful shutdown on SIGTERM,
 * correlation IDs and optional worker versioning.
 */
export async function createWorker(options: CreateWorkerOptions): Promise<NornWorker> {
  const config = resolveWorkerConfig(options);
  const { registry } = options;
  const log = Runtime.instance().logger;

  const container: Container = registry.createContainer(options.container);
  let connection: NativeConnection | undefined;
  const cleanups: Array<() => Promise<void>> = [async () => container[Symbol.asyncDispose]()];
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
    for (const name of Object.keys(options.activityOverrides ?? {})) {
      if (!registry.activities.includes(name)) {
        throw new NornConfigError(`Cannot override unknown activity ${name} (registered: ${registry.activities.join(', ') || 'none'})`);
      }
    }
    const activities = { ...(await container.activities()), ...options.activityOverrides };
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
    const workflowBundle =
      options.workflowBundle ??
      (process.env.NORN_WORKFLOW_BUNDLE ? { codePath: process.env.NORN_WORKFLOW_BUNDLE } : await bundleWorkflows(registry, { payloadConverterPath, plugins: options.plugins }));

    const create = (taskQueue: string) =>
      Worker.create({
        ...options.workerOptions,
        connection: connection!,
        namespace: config.namespace,
        taskQueue,
        workflowBundle,
        activities,
        dataConverter: options.dataConverter,
        plugins: options.plugins,
        shutdownGraceTime: config.shutdownGraceTime,
        ...(config.deployment ? { workerDeploymentOptions: config.deployment } : {}),
        interceptors: {
          ...options.workerOptions?.interceptors,
          activity: [correlationActivityInterceptor, ...(options.workerOptions?.interceptors?.activity ?? [])],
        },
      });
    try {
      const created = await Promise.allSettled(config.taskQueues.map(create));
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
  let health: HealthServer | undefined;
  if (config.healthPort !== undefined) {
    try {
      health = await startHealthServer({
        port: config.healthPort,
        host: config.healthHost,
        ready: () => {
          const details = Object.fromEntries(config.taskQueues.map((q, i) => [q, workers[i]!.getState()]));
          return { ready: state === 'RUNNING' && Object.values(details).every((s) => s === 'RUNNING'), details };
        },
      });
    } catch (error) {
      await cleanup();
      throw new NornConfigError((error as Error).message, { cause: error });
    }
    const server = health;
    cleanups.push(() => server.close());
  }

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
    log.info('Norn worker started', { taskQueues: config.taskQueues, namespace: config.namespace });
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
    taskQueues: config.taskQueues,
    config,
    get state() {
      return state;
    },
    get healthPort() {
      return health?.port;
    },
    run,
    shutdown,
    async [Symbol.asyncDispose]() {
      await shutdown();
    },
  };
}
