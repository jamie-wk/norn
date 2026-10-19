import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils.js';
import { createClient, type NornClient } from '@norn/client';
import { TEMPORAL_SEARCH_ATTRIBUTE_TYPES } from '@norn/core';
import type { QueryRef, SignalRef, UpdateRef, WorkflowContract } from '@norn/core';
import { bundleWorkflows, createWorker, type NornRegistry, type NornWorker } from '@norn/worker';
import { createLocalEnv } from '../../../tooling/test-support/temporal.ts';
import { main } from '../src/cli.ts';
import { copyFixture, removeDir } from './helpers.ts';

const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));

let dir: string;
let output = '';
const io = (env: Record<string, string> = {}) => ({ cwd: dir, env, stdout: (s: string) => (output += s), stderr: (s: string) => (output += s) });

beforeAll(async () => {
  dir = copyFixture('app');
  rmSync(join(dir, 'expected'), { recursive: true, force: true });
  if ((await main(['gen'], io())) !== 0) throw new Error(output);
});

afterAll(() => removeDir(dir));

describe('generated code', () => {
  it('typechecks together with the app, including contract and activity types', () => {
    const result = spawnSync(tsc, ['-p', join(dir, 'tsconfig.json'), '--noEmit'], { encoding: 'utf8' });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails to typecheck when API code misuses a contract', () => {
    const bad = join(dir, 'src/api/bad.ts');
    writeFileSync(
      bad,
      "import type { RefArgs } from '@norn/core';\nimport { OrderWorkflow } from '../../.norn/contracts.js';\n" +
        "export const wrong: RefArgs<typeof OrderWorkflow.signals.cancel> = [42];\nexport const missing = OrderWorkflow.signals.nope;\n",
    );
    try {
      const result = spawnSync(tsc, ['-p', join(dir, 'tsconfig.json'), '--noEmit'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("Type 'number' is not assignable to type 'string'");
      expect(result.stdout).toContain("Property 'nope' does not exist");
    } finally {
      rmSync(bad);
    }
  });
});

describe('end to end on a Temporal dev server', () => {
  let env: TestWorkflowEnvironment;
  let registry: NornRegistry;
  // Typed usage is covered by the tsc test above; here the generated module is loaded dynamically.
  type Loose = WorkflowContract<any, any, Record<string, SignalRef>, Record<string, QueryRef>, Record<string, UpdateRef>>;
  let contracts: Record<'OrderWorkflow' | 'ShoppingCart' | 'ReportWorkflow', Loose>;
  let bundle: { code: string };
  let worker: NornWorker;
  let running: Promise<void>;
  let norn: NornClient;
  const namespace = () => env.namespace ?? 'default';

  beforeAll(async () => {
    ({ registry } = (await import(join(dir, '.norn/registry.ts'))) as { registry: NornRegistry });
    contracts = await import(join(dir, '.norn/contracts.ts'));
    env = await createLocalEnv({
      searchAttributes: Object.fromEntries(Object.entries(registry.searchAttributes).map(([k, t]) => [k, TEMPORAL_SEARCH_ATTRIBUTE_TYPES[t]])),
    });
    bundle = await bundleWorkflows(registry);
    worker = await createWorker({ registry, connection: env.nativeConnection, namespace: namespace(), handleSignals: false, workflowBundle: bundle });
    running = worker.run();
    norn = createClient({ connection: env.connection, namespace: namespace() });
  });

  afterAll(async () => {
    await worker?.shutdown();
    await running;
    await env?.teardown();
  });

  it('registers what the registry declares', () => {
    expect(worker.taskQueues).toEqual(['carts', 'orders', 'reports']);
    expect(registry.workflowsPath).toBe(join(dir, '.norn/workflows.ts'));
    expect(registry.activities).toContain('payments.refund-charge');
  });

  let completedOrder = '';
  it('runs an order with updates, signals and DI-built activities', async () => {
    const orderId = `o-${Date.now()}`;
    const handle = await norn.workflow(contracts.OrderWorkflow).start({ orderId, cents: 1200, wait: true });
    expect(handle.workflowId).toBe(`order-${orderId}`);
    expect(await handle.update('addItem', 'sku-1')).toBe(1);
    // The @Validate('addItem') validator rejects the update before it is accepted.
    await expect(handle.update('addItem', '')).rejects.toThrow(/sku is required/);
    await handle.signal('transferEvent', { eventId: 'e1' });
    await handle.signal('transferEvent', { eventId: 'e1' });
    await expect.poll(async () => (await handle.query('getStatus')).status, { timeout: 15_000 }).toBe('paid');
    await handle.signal('complete');
    const result = await handle.result();
    expect(result).toEqual({ status: 'completed', chargeId: expect.stringMatching(new RegExp(`^USD-${orderId}-1200-\\d+$`)), items: ['sku-1'], stock: [9], events: ['e1'] });
    completedOrder = handle.workflowId;
  });

  it('refunds a canceled order through the renamed activity', async () => {
    const orderId = `c-${Date.now()}`;
    const handle = await norn.workflow(contracts.OrderWorkflow).start({ orderId, cents: 500, wait: true });
    await expect.poll(async () => (await handle.query('getStatus')).status, { timeout: 15_000 }).toBe('paid');
    await handle.signal('cancel', 'changed my mind');
    expect(await handle.result()).toMatchObject({ status: 'refunded', items: [], stock: [] });
  });

  it('fails the workflow for failOn errors', async () => {
    const error = await env.client.workflow
      .execute('OrderWorkflow', { taskQueue: 'orders', workflowId: `bad-${Date.now()}`, args: [{ orderId: 'bad', cents: 0 }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(((error as WorkflowFailedError).cause as { type?: string }).type).toBe('InvalidOrderError');
  });

  it('runs inherited handlers on the renamed ShoppingCart workflow', async () => {
    const cart = await norn.workflow(contracts.ShoppingCart).start({ cartId: `cart-${Date.now()}` });
    expect(await cart.update('add', 'sku-9')).toEqual({ count: 1 });
    await cart.signal('pause');
    expect(await cart.query('isPaused')).toBe(true);
    await cart.signal('checkout');
    await cart.signal('resume');
    expect(await cart.result()).toEqual(['sku-9']);
  });

  it('runs the scheduled workflow with its activity', async () => {
    const report = await norn.workflow(contracts.ReportWorkflow).execute({ kind: 'weekly' }, { workflowId: `report-${Date.now()}` });
    expect(report).toMatch(/^weekly:\d+$/);
  });

  it('pulls histories that replay against the generated bundle', async () => {
    const out = join(dir, 'histories');
    const code = await main(['histories', 'pull', completedOrder, '--out', 'histories'], io({ TEMPORAL_ADDRESS: env.address, TEMPORAL_NAMESPACE: namespace() }));
    expect(code).toBe(0);
    const file = join(out, `${completedOrder}.json`);
    expect(existsSync(file)).toBe(true);
    const history = historyFromJSON(JSON.parse(readFileSync(file, 'utf8')));
    expect(history.events?.length).toBeGreaterThan(5);
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, completedOrder);
  });

  it('reports a missing workflow', async () => {
    output = '';
    const code = await main(['histories', 'pull', 'does-not-exist'], io({ TEMPORAL_ADDRESS: env.address, TEMPORAL_NAMESPACE: namespace() }));
    expect(code).toBe(1);
    expect(output).toMatch(/error: .*not found/i);
  });
});
