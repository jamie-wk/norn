import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, type LogLevel, type WorkerOptions } from '@temporalio/worker';
import { defineSearchAttributeKey, type DataConverter } from '@temporalio/common';
import { NornConfigError, toMs, type Duration, type SearchAttributeType } from '@norn/core';
import { createClient, type NornClient, type WorkflowClient } from '@norn/client';
import { bundleWorkflows, createWorker, type NornRegistry, type NornWorker, type RegistryContainerOptions } from '@norn/worker';
import type { AnyWorkflowContract } from '@norn/core';
import { activityMap, type ActivitySource } from './mocks.js';

export type TestEnvMode = 'local' | 'time-skipping';

export interface TestEnvOptions {
  /** The generated registry. When set, a worker for its task queues runs in the background. */
  registry?: NornRegistry;
  /** `'local'` (default) runs a real dev server; `'time-skipping'` fast-forwards timers. */
  mode?: TestEnvMode;
  /** Replace activities by registered name: `mockActivities()` results or `{ name: fn }`. */
  activities?: ActivitySource | readonly ActivitySource[];
  /** Container overrides, e.g. a fake service: `{ overrides: [[Mailer, fakeMailer]] }`. */
  container?: RegistryContainerOptions;
  /** Search attributes to register on the dev server, in addition to the registry's. */
  searchAttributes?: Record<string, SearchAttributeType>;
  taskQueues?: readonly string[];
  /** Set false to skip the worker, e.g. to test starts and signals only. */
  worker?: boolean;
  /** Worker data converter, e.g. `createDataConverter()` from `@norn/codec`. */
  dataConverter?: WorkerOptions['dataConverter'];
  /** Client data converter, e.g. `clientDataConverter()` from `@norn/codec`. */
  clientDataConverter?: DataConverter;
  /** Path of an existing `temporal` CLI (local mode) or test server (time-skipping). Defaults to NORN_TEMPORAL_CLI_PATH / NORN_TEMPORAL_TEST_SERVER_PATH, otherwise the SDK downloads one. */
  serverPath?: string;
  /** SDK log level for the test process. Default `WARN` (or `NORN_TEST_LOG_LEVEL`). */
  logLevel?: LogLevel;
}

export interface TestEnv extends AsyncDisposable {
  readonly temporal: TestWorkflowEnvironment;
  readonly client: NornClient;
  readonly worker: NornWorker | undefined;
  readonly mode: TestEnvMode;
  workflow<C extends AnyWorkflowContract>(contract: C): WorkflowClient<C>;
  /** Advances time: skips it on the time-skipping server, sleeps for real on the dev server. */
  sleep(duration: Duration): Promise<void>;
  teardown(): Promise<void>;
}

const TEMPORAL_TYPES = {
  text: 'TEXT',
  keyword: 'KEYWORD',
  int: 'INT',
  double: 'DOUBLE',
  bool: 'BOOL',
  datetime: 'DATETIME',
  keywordList: 'KEYWORD_LIST',
} as const;

let runtimeChecked = false;
function quietRuntime(level: LogLevel | undefined): void {
  if (runtimeChecked) return;
  runtimeChecked = true;
  try {
    Runtime.install({ logger: new DefaultLogger(level ?? ((process.env.NORN_TEST_LOG_LEVEL as LogLevel | undefined) ?? 'WARN')) });
  } catch {
    // Someone installed a runtime already; keep theirs.
  }
}

const bundles = new Map<string, Promise<{ code: string }>>();
/** Bundles a registry's workflows once per process. */
export function cachedBundle(workflowsPath: string, payloadConverterPath?: string): Promise<{ code: string }> {
  const key = `${workflowsPath}\0${payloadConverterPath ?? ''}`;
  let bundle = bundles.get(key);
  if (!bundle) {
    bundle = bundleWorkflows({ workflowsPath }, { payloadConverterPath });
    bundle.catch(() => bundles.delete(key));
    bundles.set(key, bundle);
  }
  return bundle;
}

/**
 * Starts a Temporal test server, a Norn client and (with a registry) a worker. Dispose it with
 * `await using env = await createTestEnv(...)` or `await env.teardown()`.
 */
export async function createTestEnv(options: TestEnvOptions = {}): Promise<TestEnv> {
  quietRuntime(options.logLevel);
  const mode = options.mode ?? 'local';
  if (mode !== 'local' && mode !== 'time-skipping') throw new NornConfigError(`mode must be 'local' or 'time-skipping'`);
  const overrides = activityMap(options.activities);
  if (options.registry) {
    for (const name of Object.keys(overrides)) {
      if (!options.registry.activities.includes(name)) {
        throw new NornConfigError(`Cannot mock unknown activity ${name} (registered: ${options.registry.activities.join(', ') || 'none'})`);
      }
    }
  }

  const searchAttributes = { ...options.registry?.searchAttributes, ...options.searchAttributes };
  let temporal: TestWorkflowEnvironment;
  if (mode === 'time-skipping') {
    const path = options.serverPath ?? process.env.NORN_TEMPORAL_TEST_SERVER_PATH;
    temporal = await TestWorkflowEnvironment.createTimeSkipping(path ? { server: { executable: { type: 'existing-path', path } } } : {});
  } else {
    const path = options.serverPath ?? process.env.NORN_TEMPORAL_CLI_PATH;
    temporal = await TestWorkflowEnvironment.createLocal({
      server: {
        ...(path ? { executable: { type: 'existing-path' as const, path } } : {}),
        searchAttributes: Object.entries(searchAttributes).map(([name, type]) => defineSearchAttributeKey(name, TEMPORAL_TYPES[type])),
      },
    });
  }

  let worker: NornWorker | undefined;
  let running: Promise<void> | undefined;
  try {
    if (options.registry && options.worker !== false) {
      const payloadConverterPath = (options.dataConverter as { payloadConverterPath?: string } | undefined)?.payloadConverterPath;
      worker = await createWorker({
        registry: options.registry,
        connection: temporal.nativeConnection,
        namespace: temporal.namespace ?? 'default',
        taskQueues: options.taskQueues,
        container: options.container,
        activityOverrides: overrides,
        dataConverter: options.dataConverter,
        workflowBundle: await cachedBundle(options.registry.workflowsPath, payloadConverterPath),
        handleSignals: false,
        health: false,
        versioning: false,
        shutdownGraceTime: '5s',
      });
      running = worker.run();
    }
  } catch (error) {
    await temporal.teardown();
    throw error;
  }

  // The time-skipping client unlocks time while waiting for results; the local one adds correlation IDs.
  const client =
    mode === 'time-skipping'
      ? createClient({ client: temporal.client })
      : createClient({ connection: temporal.connection, namespace: temporal.namespace ?? 'default', dataConverter: options.clientDataConverter });

  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    try {
      await worker?.shutdown();
      await running;
    } finally {
      await client.close();
      await temporal.teardown();
    }
  };

  return {
    temporal,
    client,
    worker,
    mode,
    workflow: (contract) => client.workflow(contract),
    sleep: (duration) => temporal.sleep(toMs(duration)),
    teardown,
    [Symbol.asyncDispose]: teardown,
  };
}
