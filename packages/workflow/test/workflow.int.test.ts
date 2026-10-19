import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { WithStartWorkflowOperation, WorkflowFailedError, WorkflowUpdateFailedError, type WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { createLocalEnv, startWorkers, type RunningWorkers } from '../../../tooling/test-support/temporal.ts';

const workflowsPath = fileURLToPath(new URL('./fixtures/workflows.ts', import.meta.url));

let env: TestWorkflowEnvironment;
let workers: RunningWorkers;
let flakyAttempts = 0;

const activities = {
  'payments.charge': async (orderId: string, cents: number) => ({ id: `ch_${orderId}`, cents }),
  'payments.refund': async () => true,
  'payments.slow': async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `slept ${ms}`;
  },
  'payments.reject': async () => {
    throw ApplicationFailure.create({ type: 'PaymentRejectedError', message: 'declined', nonRetryable: true });
  },
  'payments.flaky': async () => {
    flakyAttempts++;
    if (flakyAttempts < 3) throw new Error('transient');
    return flakyAttempts;
  },
};

beforeAll(async () => {
  env = await createLocalEnv({ searchAttributes: { CustomerId: 'KEYWORD', OrderStatus: 'KEYWORD' } });
  workers = await startWorkers(env, { workflowsPath, taskQueues: ['orders', 'shipping'], activities });
});

afterAll(async () => {
  await workers?.stop();
  await env?.teardown();
});

let n = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${n++}`;

async function startOrder(orderId: string, extra: Record<string, unknown> = {}) {
  return env.client.workflow.start('OrderWorkflow', {
    taskQueue: 'orders',
    workflowId: `order-${orderId}`,
    args: [{ orderId, cents: 500, ...extra }],
  });
}

async function waitForStatus(handle: WorkflowHandle, status: string) {
  await expect
    .poll(async () => ((await handle.query('getStatus')) as { status: string }).status, { timeout: 15_000 })
    .toBe(status);
}

describe('handlers', () => {
  it('answers queries, applies updates and signals, and refunds on cancel', async () => {
    const id = uid('o');
    const handle = await startOrder(id);
    await waitForStatus(handle, 'paid');
    expect(await handle.executeUpdate('addItem', { args: ['sku-1'] })).toBe(1);
    expect(await handle.executeUpdate('addItem', { args: ['sku-2'] })).toBe(2);
    await handle.signal('cancel', 'customer request');
    const result = await handle.result();
    expect(result).toEqual({ status: 'refunded', chargeId: `ch_${id}`, items: ['sku-1', 'sku-2'], events: [] });
  });

  it('rejects updates through the validator without changing state', async () => {
    const handle = await startOrder(uid('o'));
    await waitForStatus(handle, 'paid');
    const rejected = handle.executeUpdate('addItem', { args: [''] });
    await expect(rejected).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
    const failure = (await rejected.catch((e: WorkflowUpdateFailedError) => e.cause)) as ApplicationFailure;
    expect(failure.type).toBe('InvalidItemError');
    expect(((await handle.query('getStatus')) as { items: string[] }).items).toEqual([]);
    await handle.signal('cancel', 'cleanup');
    await handle.result();
  });

  it('rejects updates after the order is canceled', async () => {
    const handle = await startOrder(uid('o'));
    await waitForStatus(handle, 'paid');
    await handle.signal('cancel', 'early');
    await expect(handle.executeUpdate('addItem', { args: ['late'] })).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
    await handle.result();
  });

  it('drops duplicate signals by dedupe key', async () => {
    const handle = await startOrder(uid('o'));
    await waitForStatus(handle, 'paid');
    await handle.signal('transfer-event', { eventId: 'e1' });
    await handle.signal('transfer-event', { eventId: 'e1' });
    await handle.signal('transfer-event', { eventId: 'e2' });
    await handle.signal('cancel', 'done');
    expect((await handle.result()).events).toEqual(['e1', 'e2']);
  });

  it('waits for in-flight async handlers before completing', async () => {
    const handle = await startOrder(uid('o'));
    await waitForStatus(handle, 'paid');
    await handle.signal('audit', 400);
    await handle.signal('cancel', 'now');
    await handle.result();
    // Without draining, the workflow would close while the audit activity is still running and its
    // completion would never reach history.
    const history = await handle.fetchHistory();
    const types = (history.events ?? []).map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name);
    const scheduled = types.indexOf('payments.slow');
    expect(scheduled).toBeGreaterThan(-1);
    const completedIds = (history.events ?? [])
      .filter((e) => e.activityTaskCompletedEventAttributes)
      .map((e) => Number(e.activityTaskCompletedEventAttributes!.scheduledEventId));
    expect(completedIds).toContain(Number(history.events![scheduled]!.eventId));
  });

  it('exposes handler descriptions and inherited handlers in workflow metadata', async () => {
    const handle = await env.client.workflow.start('PausableJobWorkflow', { taskQueue: 'orders', workflowId: uid('job'), args: [] });
    const meta = (await handle.query('__temporal_workflow_metadata')) as {
      definition: { signalDefinitions: { name: string; description?: string }[]; queryDefinitions: { name: string }[] };
    };
    const signals = meta.definition.signalDefinitions.map((s) => s.name).sort();
    expect(signals).toEqual(['finish', 'pause', 'resume']);
    expect(meta.definition.signalDefinitions.find((s) => s.name === 'pause')?.description).toBe('Pause the job');
    expect(meta.definition.queryDefinitions.map((q) => q.name)).toContain('isPaused');

    await handle.signal('pause');
    await handle.signal('finish');
    await expect.poll(() => handle.query('isPaused')).toBe(true);
    await handle.signal('resume');
    expect(await handle.result()).toBe('finished');
  });
});

describe('workflow init and update-with-start', () => {
  it('runs the constructor before the first update handler', async () => {
    const cartId = uid('cart');
    const startOp = new WithStartWorkflowOperation('CartWorkflow', {
      taskQueue: 'orders',
      workflowId: `cart-${cartId}`,
      args: [{ cartId, seed: ['a', 'b'] }],
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    const result = await env.client.workflow.executeUpdateWithStart('add', { args: ['c'], startWorkflowOperation: startOp });
    expect(result).toEqual({ count: 3 });
    const handle = await startOp.workflowHandle();
    await handle.signal('checkout');
    expect(await handle.result()).toEqual(['a', 'b', 'c']);
  });
});

describe('failures', () => {
  it('fails the workflow for failOn errors instead of retrying the task', async () => {
    const handle = await env.client.workflow.start('StrictWorkflow', { taskQueue: 'orders', workflowId: uid('strict'), args: [{ value: -1 }] });
    const error = await handle.result().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(((error as WorkflowFailedError).cause as ApplicationFailure).type).toBe('InvalidInputError');
  });

  it('runs normally when no failOn error is thrown', async () => {
    const result = await env.client.workflow.execute('StrictWorkflow', { taskQueue: 'orders', workflowId: uid('strict'), args: [{ value: 21 }] });
    expect(result).toBe(42);
  });

  it('matches activity failures by error type with asFailure()', async () => {
    const result = await env.client.workflow.execute('FailureWorkflow', { taskQueue: 'orders', workflowId: uid('fail'), args: [] });
    expect(result).toEqual({ ok: false, reason: 'declined', type: 'PaymentRejectedError' });
  });

  it('applies registry retry policies to activities', async () => {
    flakyAttempts = 0;
    const result = await env.client.workflow.execute('RetryWorkflow', { taskQueue: 'orders', workflowId: uid('retry'), args: [] });
    expect(result).toBe(3);
  });
});

describe('children, external workflows and continue-as-new', () => {
  it('starts typed children on their own queue and signals external workflows', async () => {
    const target = uid('o');
    const order = await startOrder(target);
    await waitForStatus(order, 'paid');
    const parentId = uid('p');
    const result = await env.client.workflow.execute('ParentWorkflow', {
      taskQueue: 'orders',
      workflowId: `parent-${parentId}`,
      args: [{ orderId: parentId, cancelOrder: target }],
    });
    expect(result).toEqual({ trackingId: `trk_${parentId}`, expedited: 0, parent: `parent-${parentId}` });
    expect((await order.result()).status).toBe('refunded');
  });

  it('carries state across continue-as-new without losing signals', async () => {
    const counterId = uid('c');
    const handle = await env.client.workflow.start('CounterWorkflow', {
      taskQueue: 'orders',
      workflowId: `counter-${counterId}`,
      args: [{ counterId, target: 7, perRun: 2 }],
    });
    const latest = env.client.workflow.getHandle(`counter-${counterId}`);
    for (let run = 1; run <= 3; run++) {
      await handle.signal('increment');
      await handle.signal('increment');
      try {
        await expect.poll(async () => ((await latest.query('value')) as { runs: number }).runs, { timeout: 15_000 }).toBe(run + 1);
      } catch (e) {
        process.stderr.write('DBG value ' + JSON.stringify(await latest.query('value')) + '\n');
        const h = await latest.fetchHistory();
        for (const ev of h.events ?? []) process.stderr.write('DBG ev ' + ev.eventId + ' ' + Object.keys(ev).filter((k) => k.endsWith('Attributes')).join(',') + (ev.workflowTaskFailedEventAttributes ? ' ' + JSON.stringify(ev.workflowTaskFailedEventAttributes.failure?.message) : '') + '\n');
        throw e;
      }
    }
    await handle.signal('increment');
    const result = (await latest.result()) as { count: number; runs: number };
    expect(result).toEqual({ count: 7, runs: 4 });
  });
});

describe('continueAsNew input', () => {
  it('builds the next input after in-flight handlers finish', async () => {
    const handle = await env.client.workflow.start('CarryWorkflow', { taskQueue: 'orders', workflowId: uid('carry'), args: [{}] });
    const update = handle.executeUpdate('add', { args: [5] });
    expect(await update).toBe(5);
    expect(await env.client.workflow.getHandle(handle.workflowId).result()).toBe(5);
  });
});

describe('search attributes', () => {
  it('sets declared search attributes from workflow code', async () => {
    const handle = await startOrder(uid('o'), { customerId: 'cust-42' });
    await waitForStatus(handle, 'paid');
    await expect
      .poll(async () => (await handle.describe()).searchAttributes, { timeout: 10_000 })
      .toMatchObject({ CustomerId: ['cust-42'], OrderStatus: ['paid'] });
    await handle.signal('cancel', 'done');
    await handle.result();
  });
});
