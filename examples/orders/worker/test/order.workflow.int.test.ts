// Workflow tests: real workflow code on Temporal's time-skipping server, activities mocked.
import { describe, expect, it } from 'vitest';
import { createTestEnv, mockActivities } from '@norn-ts/testing';
import { UpdateRejectedError } from '@norn-ts/core';
import { InventoryActivities, LoyaltyActivities, NotificationActivities, PaymentActivities, ShippingActivities } from '../.norn/activities.ts';
import { LoyaltyWorkflow, OrderWorkflow } from '../.norn/contracts.ts';
import { registry } from '../.norn/registry.ts';
import { OutOfStockError, PaymentDeclinedError } from '../src/domain.ts';

let n = 0;
const order = (overrides: Record<string, unknown> = {}) => ({
  orderId: `o-${Date.now()}-${n++}`,
  customerId: 'c-1',
  email: 'buyer@example.com',
  card: 'tok_visa',
  items: [{ sku: 'sku-book', qty: 2 }],
  ...overrides,
});

function mocks() {
  return {
    payments: mockActivities(PaymentActivities, {
      charge: async (orderId, amountCents) => ({ chargeId: `ch-${orderId}`, amountCents }),
      refund: async () => ({ refundId: 're-1' }),
    }),
    inventory: mockActivities(InventoryActivities, {
      reserve: async (_orderId, items) => ({ totalCents: items.reduce((s, i) => s + i.qty * 1_500, 0) }),
      release: async () => undefined,
    }),
    notify: mockActivities(NotificationActivities, { email: async () => ({ messageId: 'm' }) }),
    shipping: mockActivities(ShippingActivities, { createLabel: async () => ({ trackingNumber: 'TRK1' }) }),
    loyalty: mockActivities(LoyaltyActivities, { credit: async () => undefined }),
  };
}

describe('OrderWorkflow', () => {
  it('ships after the cancellation window (an hour, skipped instantly)', async () => {
    const m = mocks();
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: Object.values(m) });
    const result = await env.workflow(OrderWorkflow).execute(order());
    expect(result).toMatchObject({ status: 'completed', totalCents: 3_000, trackingNumber: 'TRK1' });
    expect(m.notify.email.calls.map((c) => c[1])).toEqual(['order_paid', 'order_shipped']);
    expect(m.loyalty.credit.calls).toHaveLength(1);
  });

  it('refunds when cancelled during the window', async () => {
    const m = mocks();
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: Object.values(m) });
    const input = order({ cancelWindow: '1 day' });
    const handle = await env.workflow(OrderWorkflow).start(input);
    await expect.poll(async () => (await handle.query('view')).status).toBe('paid');
    await handle.signal('cancel', 'changed mind');
    expect(await handle.result()).toMatchObject({ status: 'refunded' });
    expect(m.payments.refund.calls).toEqual([[input.orderId, `ch-${input.orderId}`]]);
    expect(m.shipping.createLabel.calls).toHaveLength(0);
  });

  it('fails the payment without retrying a declined card', async () => {
    const m = mocks();
    let attempts = 0;
    const payments = mockActivities(PaymentActivities, {
      charge: async () => {
        attempts++;
        throw new PaymentDeclinedError('insufficient funds');
      },
    });
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: [...Object.values(m), payments] });
    const result = await env.workflow(OrderWorkflow).execute(order());
    expect(result).toMatchObject({ status: 'payment_failed', failure: 'insufficient funds' });
    expect(attempts).toBe(1);
    expect(m.inventory.release.calls).toHaveLength(1);
  });

  it('rejects invalid starting items without reserving or charging', async () => {
    const m = mocks();
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: Object.values(m) });
    for (const items of [[{ sku: 'sku-book', qty: -2 }], [{ sku: 'sku-book' }], [{ sku: 'constructor', qty: 1 }]]) {
      const result = await env.workflow(OrderWorkflow).execute(order({ items }));
      expect(result).toMatchObject({ status: 'rejected', totalCents: 0 });
      expect(result.failure).toBeTruthy();
    }
    expect(m.inventory.reserve.calls).toHaveLength(0);
    expect(m.payments.charge.calls).toHaveLength(0);
  });

  it('rejects out-of-stock orders without charging', async () => {
    const m = mocks();
    const inventory = mockActivities(InventoryActivities, {
      reserve: async () => {
        throw new OutOfStockError('sku-book is out of stock');
      },
    });
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: [...Object.values(m), inventory] });
    const result = await env.workflow(OrderWorkflow).execute(order());
    expect(result).toMatchObject({ status: 'rejected', failure: 'sku-book is out of stock' });
    expect(inventory.reserve.calls).toHaveLength(1);
    expect(m.payments.charge.calls).toHaveLength(0);
  });

  it('releases the reservation when the charge keeps failing', async () => {
    const m = mocks();
    const payments = mockActivities(PaymentActivities, {
      charge: async () => {
        throw new Error('gateway down');
      },
    });
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: [...Object.values(m), payments] });
    await expect(env.workflow(OrderWorkflow).execute(order())).rejects.toThrow();
    expect(payments.charge.calls.length).toBeGreaterThan(1);
    expect(m.inventory.release.calls).toHaveLength(1);
  });

  it('reports completed only after the last email and loyalty credit', async () => {
    const m = mocks();
    let creditStarted!: () => void;
    let releaseCredit!: () => void;
    const credited = new Promise<void>((r) => (creditStarted = r));
    const gate = new Promise<void>((r) => (releaseCredit = r));
    const loyalty = mockActivities(LoyaltyActivities, {
      credit: async () => {
        creditStarted();
        await gate;
      },
    });
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: [...Object.values(m), loyalty] });
    const handle = await env.workflow(OrderWorkflow).start(order());
    const result = handle.result();
    await credited;
    const during = (await handle.query('view')).status;
    releaseCredit();
    expect(during).toBe('shipping');
    expect(await result).toMatchObject({ status: 'completed' });
  });

  it('validates cart updates before they reach workflow state', async () => {
    await using env = await createTestEnv({ registry, activities: Object.values(mocks()) });
    const handle = await env.workflow(OrderWorkflow).start(order({ items: [], submit: false }));
    await expect(handle.update('addItem', { sku: 'sku-nope', qty: 1 })).rejects.toBeInstanceOf(UpdateRejectedError);
    await expect(handle.update('submit')).rejects.toMatchObject({ failureType: 'InvalidItemError' });
    expect(await handle.update('addItem', { sku: 'sku-mug', qty: 2 })).toMatchObject({ items: [{ sku: 'sku-mug', qty: 2 }] });
    expect(await handle.update('submit')).toMatchObject({ status: 'paid' });
    await handle.signal('cancel', 'cleanup');
  });

  it('expires carts that are never submitted', async () => {
    await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: Object.values(mocks()) });
    const result = await env.workflow(OrderWorkflow).execute(order({ items: [], submit: false }));
    expect(result.status).toBe('expired');
  });
});

describe('LoyaltyWorkflow', () => {
  it('counts every order, beyond the dedupe window and across continue-as-new', async () => {
    await using env = await createTestEnv({ registry, activities: Object.values(mocks()) });
    const customerId = `c-${Date.now()}`;
    const recent = Array.from({ length: 200 }, (_, i) => `old-${i}`);
    const handle = await env.workflow(LoyaltyWorkflow).start({ customerId, points: 0, recent, orders: 200, maxEventsPerRun: 1 });
    await handle.signal('orderCompleted', { orderId: 'new-1', cents: 1_000 });
    await expect.poll(async () => (await handle.query('balance')).orders).toBe(201);
    await handle.signal('orderCompleted', { orderId: 'new-1', cents: 1_000 });
    await handle.signal('orderCompleted', { orderId: 'new-2', cents: 1_000 });
    await expect.poll(async () => await handle.query('balance')).toEqual({ points: 20, orders: 202 });
  });
});
