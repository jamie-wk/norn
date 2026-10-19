/**
 * Repo-internal helpers for integration tests that need a real Temporal server.
 *
 * Reuses @norn-ts/testing's runtime setup, bundle cache and search-attribute wait. Uses an existing
 * `temporal` binary when NORN_TEMPORAL_CLI_PATH is set, and otherwise lets the SDK download one.
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type WorkerOptions } from '@temporalio/worker';
import { defineSearchAttributeKey, type SearchAttributeType } from '@temporalio/common';
import { cachedBundle, quietRuntime, waitForSearchAttributes } from '../../packages/testing/src/env.ts';

export interface LocalEnvOptions {
  searchAttributes?: Record<string, SearchAttributeType>;
}

/** A real Temporal dev server (temporal server start-dev), torn down with the environment. */
export async function createLocalEnv(options: LocalEnvOptions = {}): Promise<TestWorkflowEnvironment> {
  quietRuntime(undefined);
  const path = process.env.NORN_TEMPORAL_CLI_PATH;
  const searchAttributes = options.searchAttributes ?? {};
  const env = await TestWorkflowEnvironment.createLocal({
    server: {
      ...(path ? { executable: { type: 'existing-path' as const, path } } : {}),
      searchAttributes: Object.entries(searchAttributes).map(([name, type]) => defineSearchAttributeKey(name, type)),
    },
  });
  try {
    await waitForSearchAttributes(env, Object.keys(searchAttributes));
  } catch (error) {
    await env.teardown();
    throw error;
  }
  return env;
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
  const workflowBundle = await cachedBundle(workflowsPath);
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
