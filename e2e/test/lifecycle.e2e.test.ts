import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@norn/client';
import { LoyaltyWorkflow, OrderWorkflow } from '@norn/example-orders-contracts';
import { startStack, type Stack } from '../src/stack.ts';
import { newOrder, uid, waitForStatus } from '../src/helpers.ts';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.teardown();
});

describe('worker lifecycle', () => {
  it('E12: on SIGTERM the worker stops taking work, finishes in-flight activities and exits cleanly', async () => {
    await stack.script({ route: 'shipments', delayMs: 4_000 });
    const order = newOrder();
    await stack.api('/orders', { body: order });
    await waitForStatus(stack, order.orderId, 'shipping');
    await new Promise((r) => setTimeout(r, 500)); // the label request is now in flight

    const stopping = stack.worker.stop();
    await expect.poll(() => stack.worker.readyz().catch(() => 0), { timeout: 5_000 }).not.toBe(200);
    const exit = await stopping;
    expect(exit.code).toBe(0);
    // The slow label call completed during the drain rather than being abandoned.
    const shipments = (await stack.providerCalls('shipments')).filter((c) => c.body.orderId === order.orderId);
    expect(shipments.map((c) => c.status)).toEqual([201]);

    await stack.worker.start();
    const done = await waitForStatus(stack, order.orderId, 'completed');
    expect(done.trackingNumber).toMatch(/^TRK/);
  });

  it('E13: orders accepted while no worker is running complete once one starts', async () => {
    await stack.worker.stop();
    const order = newOrder();
    const created = await stack.api('/orders', { body: order });
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 1_000));
    const description = await stack.temporal.workflow.getHandle(`order-${order.orderId}`).describe();
    expect(description.status.name).toBe('RUNNING');
    expect((await stack.providerCalls('charges')).some((c) => c.body.orderId === order.orderId)).toBe(false);

    await stack.worker.start();
    await waitForStatus(stack, order.orderId, 'completed');
  });
});

describe('long-running workflows', () => {
  it('E9: continue-as-new keeps state and never double-counts redelivered events', async () => {
    const norn = createClient({ client: stack.temporal });
    const customerId = uid('loyal');
    const loyalty = norn.workflow(LoyaltyWorkflow);
    await loyalty.start({ customerId, maxEventsPerRun: 2 });
    for (const [orderId, cents] of [['a', 1_000], ['b', 2_000], ['b', 2_000], ['c', 550], ['d', 100], ['e', 4_999]] as const) {
      await loyalty.signalWithStart({ customerId, maxEventsPerRun: 2 }, { signal: 'orderCompleted', args: [{ orderId, cents }] });
    }
    await expect.poll(() => loyalty.get({ customerId }).query('balance'), { timeout: 20_000 }).toEqual({ points: 10 + 20 + 5 + 1 + 49, orders: 5 });
    const runs = await stack.temporal.workflow.count(`WorkflowId = "loyalty-${customerId}"`);
    expect(runs.count).toBeGreaterThanOrEqual(3);
  });
});

describe('schedules', () => {
  it('E18: `norn schedules sync` creates the declared schedule idempotently and it runs', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const env = { ...process.env, TEMPORAL_ADDRESS: stack.temporalAddress, TEMPORAL_NAMESPACE: stack.namespace };
    const cli = new URL('../../packages/cli/dist/bin.js', import.meta.url).pathname;
    const cwd = new URL('../../examples/orders/worker', import.meta.url).pathname;

    const first = await run(process.execPath, [cli, 'schedules', 'sync'], { cwd, env });
    expect(first.stdout).toMatch(/created.*daily-sales-report/is);
    const second = await run(process.execPath, [cli, 'schedules', 'sync'], { cwd, env });
    expect(second.stdout).toMatch(/unchanged.*daily-sales-report/is);

    const schedule = stack.temporal.schedule.getHandle('daily-sales-report');
    const description = await schedule.describe();
    expect(description.action).toMatchObject({ workflowType: 'DailyReportWorkflow', taskQueue: 'orders' });
    await schedule.trigger();
    await expect
      .poll(async () => (await stack.providerCalls('emails')).some((c) => c.body.to === 'ops@example.com' && c.body.template === 'daily_report'), { timeout: 20_000 })
      .toBe(true);
    await schedule.delete();
  });
});

describe('contracts', () => {
  it('lets other services read orders with the typed client', async () => {
    const order = newOrder({ cancelWindow: '1 minute' });
    await stack.api('/orders', { body: order });
    const norn = createClient({ client: stack.temporal });
    await expect.poll(async () => (await norn.workflow(OrderWorkflow).get({ orderId: order.orderId }).query('view')).status, { timeout: 20_000 }).toBe('paid');
    const found: string[] = [];
    await expect
      .poll(async () => {
        found.length = 0;
        for await (const w of norn.workflow(OrderWorkflow).list(`CustomerId = "${order.customerId}"`)) found.push(w.workflowId);
        return found;
      }, { timeout: 20_000 })
      .toEqual([`order-${order.orderId}`]);
    await norn.workflow(OrderWorkflow).get({ orderId: order.orderId }).signal('cancel', 'cleanup');
  });
});
