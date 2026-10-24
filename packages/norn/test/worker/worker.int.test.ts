import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { NativeConnection, Worker, type BundlerPlugin, type WorkerPlugin } from '@temporalio/worker';
import { createClient, type NornClient } from '../../src/client/index.ts';
import { NornConfigError, TemporalUnavailableError } from '../../src/core/index.ts';
import { createLocalEnv } from '../../../../tooling/test-support/temporal.ts';
import { bundleWorkflows, createWorker, type NornWorker } from '../../src/worker/index.ts';
import { GreetActivities, calls } from './fixtures/activities.ts';
import { GreetWorkflow, SlowWorkflow } from './fixtures/workflow-classes.ts';

const workflows = new URL('./fixtures/workflows.ts', import.meta.url);

let env: TestWorkflowEnvironment;
let norn: NornClient;
let bundle: { code: string };

beforeAll(async () => {
  env = await createLocalEnv();
  norn = createClient({ connection: env.connection, namespace: env.namespace ?? 'default' });
  bundle = await bundleWorkflows(workflows);
});

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  calls.length = 0;
});

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${n++}`;
const base = () => ({
  workflows,
  activities: { greet: new GreetActivities('Hello') },
  connection: env.nativeConnection,
  namespace: env.namespace ?? 'default',
  handleSignals: false,
  workflowBundle: bundle,
});

async function withRunning<T>(worker: NornWorker, fn: () => Promise<T>): Promise<T> {
  const running = worker.run();
  try {
    return await fn();
  } finally {
    await worker.shutdown();
    await running;
  }
}

describe('createWorker', () => {
  it('runs every task queue the workflows declare, with the given activities', async () => {
    const worker = await createWorker(base());
    expect(worker.taskQueues).toEqual(['w-main', 'w-reports']);
    const name = uid('ada');
    const result = await withRunning(worker, () => norn.workflow(GreetWorkflow).execute({ name }));
    expect(result).toEqual({ greeting: `Hello, ${name}`, report: `report for ${name}` });
    expect(worker.state).toBe('STOPPED');
  });

  it('fails non-retryable activity errors once, matchable by name in the workflow', async () => {
    const worker = await createWorker(base());
    const result = await withRunning(worker, () => norn.workflow(GreetWorkflow).execute({ name: 'blocked' }, { workflowId: uid('blocked') }));
    expect(result).toEqual({ blocked: 'blocked is blocked' });
    expect(calls.filter((c) => c === 'hello:blocked')).toHaveLength(1);
  });

  it('takes plain objects as activities, e.g. fakes', async () => {
    const worker = await createWorker({ ...base(), activities: { greet: { hello: async (name: string) => `fake ${name}` } } });
    const name = uid('fake');
    expect(await withRunning(worker, () => norn.workflow(GreetWorkflow).execute({ name }))).toMatchObject({ greeting: `fake ${name}` });
  });

  it('bundles the workflows itself when no bundle is given, applying worker plugins', async () => {
    // Real plugins (e.g. OpenTelemetry's) implement both interfaces.
    const plugin: WorkerPlugin & BundlerPlugin = { name: 'spy', configureBundler: vi.fn((o) => o) };
    const worker = await createWorker({ ...base(), workflowBundle: undefined, plugins: [plugin] });
    expect(plugin.configureBundler).toHaveBeenCalledOnce();
    const name = uid('self');
    expect(await withRunning(worker, () => norn.workflow(GreetWorkflow).execute({ name }))).toMatchObject({ greeting: `Hello, ${name}` });
  });

  it('loads a prebuilt bundle from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'norn-bundle-'));
    try {
      const outFile = join(dir, 'workflow-bundle.js');
      await bundleWorkflows(workflows, { outFile });
      const worker = await createWorker({ ...base(), workflowBundle: { codePath: outFile } });
      const name = uid('file');
      expect(await withRunning(worker, () => norn.workflow(GreetWorkflow).execute({ name }))).toMatchObject({ greeting: `Hello, ${name}` });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drains in-flight activities on shutdown, then another worker finishes the workflow', async () => {
    const first = await createWorker({ ...base(), shutdownGraceTime: '20s' });
    const running = first.run();
    const handle = await norn.workflow(SlowWorkflow).start({ ms: 1500 }, { workflowId: uid('slow') });
    await expect.poll(async () => (await handle.temporal.describe()).raw.pendingActivities?.length ?? 0, { timeout: 10_000 }).toBe(1);
    await first.shutdown();
    await running;
    expect(calls).toContain('slow:1500');

    const second = await createWorker(base());
    expect(await withRunning(second, () => handle.result())).toBe(1500);
  });

  it('runs activities only, on the task queues given', async () => {
    const worker = await createWorker({ ...base(), workflows: undefined, workflowBundle: undefined, taskQueues: ['w-activities'] });
    expect(worker.taskQueues).toEqual(['w-activities']);
    await worker.shutdown();
  });

  it('ignores NORN_WORKFLOW_BUNDLE on an activity-only worker', async () => {
    vi.stubEnv('NORN_WORKFLOW_BUNDLE', join(tmpdir(), 'norn-missing-bundle.js'));
    try {
      const worker = await createWorker({ ...base(), workflows: undefined, workflowBundle: undefined, taskQueues: ['w-activities'] });
      expect(worker.taskQueues).toEqual(['w-activities']);
      await worker.shutdown();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('startup failures', () => {
  it('needs workflows, or task queues for an activity-only worker', async () => {
    await expect(createWorker({ ...base(), workflows: undefined })).rejects.toThrow(NornConfigError);
  });

  it('rejects a workflows module without @Workflow classes', async () => {
    await expect(createWorker({ ...base(), workflows: new URL('./fixtures/activities.ts', import.meta.url) })).rejects.toThrow(/exports no @Workflow classes/);
  });

  it('reports an unreachable server as TemporalUnavailableError', async () => {
    const { connection: _, ...options } = base();
    const error = await createWorker({ ...options, address: '127.0.0.1:1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemporalUnavailableError);
  }, 60_000);

  // Temporal workers that were created but never run hold the connection (and worker threads) open.
  const ownConnection = () => NativeConnection.connect({ address: env.address });

  it('releases its Temporal workers when shut down before running', async () => {
    const connection = await ownConnection();
    const worker = await createWorker({ ...base(), connection });
    await worker.shutdown();
    expect(worker.state).toBe('STOPPED');
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it('releases the Temporal workers it did create when another task queue fails', async () => {
    const create = Worker.create.bind(Worker);
    let main: Promise<Worker> | undefined;
    const spy = vi.spyOn(Worker, 'create').mockImplementation(async (opts) => {
      if (opts.taskQueue !== 'w-reports') return (main = create(opts));
      await main; // fail only once the other worker exists and holds the connection
      throw new Error('w-reports could not be created');
    });
    const connection = await ownConnection();
    try {
      await expect(createWorker({ ...base(), connection })).rejects.toThrow(/w-reports could not be created/);
      await expect(connection.close()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
