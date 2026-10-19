import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { NativeConnection, Worker, type BundlerPlugin, type WorkerPlugin } from '@temporalio/worker';
import { createServer } from 'node:net';
import { createContainer } from '@norn-ts/activity';
import { createClient, runWithCorrelationId, type NornClient } from '@norn-ts/client';
import { clientDataConverter, createDataConverter, generateKey } from '@norn-ts/codec';
import { TemporalUnavailableError, contract } from '@norn-ts/core';
import { createLocalEnv } from '../../../tooling/test-support/temporal.ts';
import { bundleWorkflows, createWorker, type NornWorker } from '../src/index.ts';
import { Config, GreetActivities, Greeter, calls } from './fixtures/activities.ts';
import { disposed, registry } from './fixtures/registry.ts';
import type { GreetWorkflow as GreetWorkflow$, SlowWorkflow as SlowWorkflow$ } from './fixtures/workflow-classes.ts';

const Greet = contract<typeof GreetWorkflow$>()({ name: 'GreetWorkflow', taskQueue: 'w-main', id: 'greet-{name}' });
const Slow = contract<typeof SlowWorkflow$>()({ name: 'SlowWorkflow', taskQueue: 'w-main' });

let env: TestWorkflowEnvironment;
let norn: NornClient;
let bundle: { code: string };

beforeAll(async () => {
  env = await createLocalEnv();
  norn = createClient({ connection: env.connection, namespace: env.namespace ?? 'default' });
  bundle = await bundleWorkflows(registry);
});

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  calls.length = 0;
  disposed.length = 0;
});

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${n++}`;
const base = () => ({ connection: env.nativeConnection, namespace: env.namespace ?? 'default', handleSignals: false, workflowBundle: bundle });

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
  it('runs every task queue with DI-built activities and propagates correlation IDs', async () => {
    const worker = await createWorker({ registry, ...base() });
    expect(worker.taskQueues).toEqual(['w-main', 'w-reports']);
    const name = uid('ada');
    const result = await withRunning(worker, () => runWithCorrelationId('req-7', () => norn.workflow(Greet).execute({ name })));
    expect(result).toEqual({ greeting: `Hello, ${name}`, correlation: 'req-7', childCorrelation: 'req-7' });
    expect(worker.state).toBe('STOPPED');
    expect(disposed).toEqual(['Config']);
  });

  it('fails non-retryable activity errors once, matchable by class name in the workflow', async () => {
    const worker = await createWorker({ registry, ...base() });
    const result = await withRunning(worker, () => norn.workflow(Greet).execute({ name: 'blocked' }, { workflowId: uid('blocked') }));
    expect(result).toEqual({ blocked: 'blocked is blocked' });
    expect(calls.filter((c) => c === 'hello:blocked')).toHaveLength(1);
  });

  it('applies container overrides', async () => {
    const worker = await createWorker({ registry, ...base(), container: { overrides: [[Config, { greeting: 'Hi' }]] } });
    const name = uid('bob');
    const result = await withRunning(worker, () => norn.workflow(Greet).execute({ name }));
    expect(result).toMatchObject({ greeting: `Hi, ${name}` });
  });

  it('replaces activities by name with activityOverrides', async () => {
    const worker = await createWorker({ registry, ...base(), activityOverrides: { 'greet.hello': async (name: string) => `mocked ${name}` } });
    const name = uid('mock');
    expect(await withRunning(worker, () => norn.workflow(Greet).execute({ name }))).toMatchObject({ greeting: `mocked ${name}` });
    expect(calls).toEqual([]);
  });

  it('bundles the registry itself when no bundle is given, applying worker plugins', async () => {
    // Real plugins (e.g. OpenTelemetry's) implement both interfaces.
    const plugin: WorkerPlugin & BundlerPlugin = { name: 'spy', configureBundler: vi.fn((o) => o) };
    const worker = await createWorker({ registry, connection: env.nativeConnection, handleSignals: false, plugins: [plugin] });
    expect(plugin.configureBundler).toHaveBeenCalledOnce();
    const name = uid('self');
    expect(await withRunning(worker, () => norn.workflow(Greet).execute({ name }))).toMatchObject({ greeting: `Hello, ${name}` });
  });

  it('loads a prebuilt bundle from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'norn-bundle-'));
    try {
      const outFile = join(dir, 'workflow-bundle.js');
      await bundleWorkflows(registry, { outFile });
      const worker = await createWorker({ registry, connection: env.nativeConnection, handleSignals: false, workflowBundle: { codePath: outFile } });
      const name = uid('file');
      expect(await withRunning(worker, () => norn.workflow(Greet).execute({ name }))).toMatchObject({ greeting: `Hello, ${name}` });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves health and readiness while running', async () => {
    const worker = await createWorker({ registry, ...base(), health: { port: 0 } });
    const running = worker.run();
    const url = `http://127.0.0.1:${worker.healthPort}`;
    await expect.poll(async () => (await fetch(`${url}/readyz`)).status).toBe(200);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const stopping = worker.shutdown();
    await stopping;
    await running;
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });

  it('drains in-flight activities on shutdown, then another worker finishes the workflow', async () => {
    const first = await createWorker({ registry, ...base(), shutdownGraceTime: '20s' });
    const running = first.run();
    const handle = await norn.workflow(Slow).start({ ms: 1500 }, { workflowId: uid('slow') });
    await expect.poll(async () => (await handle.temporal.describe()).raw.pendingActivities?.length ?? 0, { timeout: 10_000 }).toBe(1);
    await first.shutdown();
    await running;
    expect(calls).toContain('slow:1500');

    const second = await createWorker({ registry, ...base() });
    expect(await withRunning(second, () => handle.result())).toBe(1500);
  });

  it('encrypts payloads with a codec data converter', async () => {
    const keys = { k1: generateKey() };
    const worker = await createWorker({ registry, ...base(), workflowBundle: undefined, dataConverter: createDataConverter({ keys, currentKeyId: 'k1' }) });
    const secure = createClient({ connection: env.connection, dataConverter: clientDataConverter({ keys, currentKeyId: 'k1' }) });
    const name = uid('secret');
    const result = await withRunning(worker, () => secure.workflow(Greet).execute({ name }));
    expect(result).toMatchObject({ greeting: `Hello, ${name}` });
    const history = await env.client.workflow.getHandle(`greet-${name}`).fetchHistory();
    const input = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    expect(new TextDecoder().decode(input?.metadata?.encoding as Uint8Array)).toBe('binary/encrypted');
  });
});

describe('startup failures', () => {
  it('fails fast when a dependency has no provider', async () => {
    const broken = {
      ...registry,
      createContainer: (o = {}) => createContainer({ services: [{ cls: Greeter }], activities: [{ cls: GreetActivities }], ...o }),
    };
    await expect(createWorker({ registry: broken, ...base() })).rejects.toThrow(/No provider for Config/);
  });

  it('reports an unreachable server as TemporalUnavailableError', async () => {
    const error = await createWorker({ registry, address: '127.0.0.1:1', handleSignals: false, workflowBundle: bundle }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemporalUnavailableError);
  }, 60_000);

  it('rejects overrides for activities that do not exist', async () => {
    await expect(createWorker({ registry, ...base(), activityOverrides: { 'greet.nope': async () => 1 } })).rejects.toThrow(/unknown activity greet\.nope/);
    // Validation runs before anything is created.
    expect(disposed).toEqual([]);
  });

  // Temporal workers that were created but never run hold the connection (and worker threads) open.
  const ownConnection = () => NativeConnection.connect({ address: env.address });

  it('releases its Temporal workers when shut down before running', async () => {
    const connection = await ownConnection();
    const worker = await createWorker({ registry, ...base(), connection });
    await worker.shutdown();
    expect(worker.state).toBe('STOPPED');
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it('releases its Temporal workers when the health server cannot start', async () => {
    const taken = createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => taken.once('listening', resolve));
    const connection = await ownConnection();
    try {
      const port = (taken.address() as { port: number }).port;
      await expect(createWorker({ registry, ...base(), connection, health: { port, host: '127.0.0.1' } })).rejects.toThrow(/EADDRINUSE/);
      await expect(connection.close()).resolves.toBeUndefined();
    } finally {
      taken.close();
    }
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
      await expect(createWorker({ registry, ...base(), connection })).rejects.toThrow(/w-reports could not be created/);
      await expect(connection.close()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects task queues the registry does not use', async () => {
    await expect(createWorker({ registry, ...base(), taskQueues: ['typo'] })).rejects.toThrow(/typo/);
  });
});
