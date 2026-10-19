/**
 * Repo-internal helpers for integration tests that need a real Temporal server.
 *
 * Uses existing server binaries when NORN_TEMPORAL_CLI_PATH / NORN_TEMPORAL_TEST_SERVER_PATH are
 * set (offline sandboxes), and otherwise lets the SDK download them (CI).
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker, bundleWorkflowCode, type WorkerOptions } from '@temporalio/worker';
import { defineSearchAttributeKey, type SearchAttributeType } from '@temporalio/common';
import { nornWebpackConfigHook } from '../../packages/worker/src/bundler.ts';

let runtimeInstalled = false;
export function quietRuntime(): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    Runtime.install({ logger: new DefaultLogger((process.env.NORN_TEST_LOG_LEVEL as 'WARN') ?? 'WARN') });
  } catch {
    // Already installed by another helper in this process.
  }
}

const cliPath = () => process.env.NORN_TEMPORAL_CLI_PATH;
const testServerPath = () => process.env.NORN_TEMPORAL_TEST_SERVER_PATH;

export interface LocalEnvOptions {
  searchAttributes?: Record<string, SearchAttributeType>;
}

/** A real Temporal dev server (temporal server start-dev), torn down with the environment. */
export async function createLocalEnv(options: LocalEnvOptions = {}): Promise<TestWorkflowEnvironment> {
  quietRuntime();
  const path = cliPath();
  return TestWorkflowEnvironment.createLocal({
    server: {
      ...(path ? { executable: { type: 'existing-path' as const, path } } : {}),
      searchAttributes: Object.entries(options.searchAttributes ?? {}).map(([name, type]) => defineSearchAttributeKey(name, type)),
    },
  });
}

/** Temporal's time-skipping test server. */
export async function createTimeSkippingEnv(): Promise<TestWorkflowEnvironment> {
  quietRuntime();
  const path = testServerPath();
  return TestWorkflowEnvironment.createTimeSkipping(
    path ? { server: { executable: { type: 'existing-path' as const, path } } } : {},
  );
}

const bundles = new Map<string, Promise<{ code: string }>>();

/** Bundles a workflows module once per process, with Norn's bundler settings. */
export function bundleOnce(workflowsPath: string): Promise<{ code: string }> {
  let bundle = bundles.get(workflowsPath);
  if (!bundle) {
    bundle = bundleWorkflowCode({
      workflowsPath,
      webpackConfigHook: nornWebpackConfigHook() as never,
      logger: new DefaultLogger('WARN'),
    });
    bundles.set(workflowsPath, bundle);
  }
  return bundle;
}

let queueCounter = 0;
export function uniqueQueue(prefix = 'test'): string {
  return `${prefix}-${process.pid}-${Date.now()}-${queueCounter++}`;
}

export interface RunningWorkers {
  stop(): Promise<void>;
}

/** Starts one worker per task queue in the background; call `stop()` in afterAll. */
export async function startWorkers(
  env: TestWorkflowEnvironment,
  options: Omit<WorkerOptions, 'connection' | 'workflowBundle' | 'workflowsPath' | 'taskQueue'> & {
    workflowsPath: string;
    taskQueues: string[];
  },
): Promise<RunningWorkers> {
  const { workflowsPath, taskQueues, ...rest } = options;
  const workflowBundle = await bundleOnce(workflowsPath);
  const workers = await Promise.all(
    taskQueues.map((taskQueue) =>
      Worker.create({
        ...rest,
        taskQueue,
        connection: env.nativeConnection,
        namespace: env.namespace ?? 'default',
        workflowBundle,
      }),
    ),
  );
  const running = workers.map((w) => w.run());
  return {
    async stop() {
      for (const w of workers) if (w.getState() === 'RUNNING') w.shutdown();
      await Promise.allSettled(running);
    },
  };
}

/** Runs `fn` while a worker polls `taskQueue`, then shuts the worker down. */
export async function withWorker<T>(
  env: TestWorkflowEnvironment,
  options: Omit<WorkerOptions, 'connection' | 'workflowBundle' | 'workflowsPath'> & { workflowsPath: string },
  fn: () => Promise<T>,
): Promise<T> {
  const { workflowsPath, ...rest } = options;
  const worker = await Worker.create({
    ...rest,
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    workflowBundle: await bundleOnce(workflowsPath),
  });
  return worker.runUntil(fn);
}
