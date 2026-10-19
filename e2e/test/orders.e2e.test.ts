import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '../src/stack.ts';
import { newOrder, uid, waitForStatus } from '../src/helpers.ts';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.teardown();
});

describe('happy paths', () => {
  it('E1: pays, waits out the cancellation window, ships, emails and credits loyalty points', async () => {
    const order = newOrder();
    const created = await stack.api('/orders', { body: order });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ orderId: order.orderId, workflowId: `order-${order.orderId}` });

    const done = await waitForStatus(stack, order.orderId, 'completed');
    expect(done).toMatchObject({ totalCents: 3_900, items: order.items, workflowStatus: 'COMPLETED' });
    expect(done.chargeId).toMatch(/^ch_/);
    expect(done.trackingNumber).toMatch(/^TRK/);

    const charges = (await stack.providerCalls('charges')).filter((c) => c.body.orderId === order.orderId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ idempotencyKey: `charge-${order.orderId}`, status: 201, body: { amountCents: 3_900 } });
    const shipments = (await stack.providerCalls('shipments')).filter((c) => c.body.orderId === order.orderId);
    expect(shipments).toHaveLength(1);
    const emails = (await stack.providerCalls('emails')).filter((c) => c.body.to === order.email).map((c) => c.body.template);
    expect(emails).toEqual(['order_paid', 'order_shipped']);

    await expect.poll(async () => (await stack.api(`/customers/${order.customerId}/loyalty`)).body, { timeout: 15_000 }).toEqual({ points: 39, orders: 1 });
  });

  it('E6: builds a cart with update-with-start, submits it and waits for the payment result', async () => {
    const cartId = uid('cart');
    const buyer = { customerId: uid('cust'), email: `${uid('cart')}@example.com`, card: 'tok_visa' };
    const first = await stack.api(`/carts/${cartId}/items`, { body: { ...buyer, sku: 'sku-shirt', qty: 1 } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'open', items: [{ sku: 'sku-shirt', qty: 1 }] });
    const second = await stack.api(`/carts/${cartId}/items`, { body: { ...buyer, sku: 'sku-shirt', qty: 2 } });
    expect(second.body.items).toEqual([{ sku: 'sku-shirt', qty: 3 }]);
    const third = await stack.api(`/orders/${cartId}/items`, { body: { sku: 'sku-sticker', qty: 5 } });
    expect(third.body.items).toHaveLength(2);

    const submitted = await stack.api(`/orders/${cartId}/submit`, { method: 'POST' });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'paid', totalCents: 3 * 2_400 + 5 * 200 });
    await stack.api(`/orders/${cartId}/cancel`, { body: { reason: 'changed my mind' } });
    await waitForStatus(stack, cartId, 'refunded');
  });

  it('E7: cancelling inside the window refunds the charge with its own idempotency key', async () => {
    const order = newOrder({ cancelWindow: '1 minute' });
    await stack.api('/orders', { body: order });
    await waitForStatus(stack, order.orderId, 'paid');
    const cancel = await stack.api(`/orders/${order.orderId}/cancel`, { body: { reason: 'too slow' } });
    expect(cancel.status).toBe(202);
    await waitForStatus(stack, order.orderId, 'refunded');
    const refunds = (await stack.providerCalls('refunds')).filter((c) => c.idempotencyKey === `refund-${order.orderId}`);
    expect(refunds).toHaveLength(1);
    const emails = (await stack.providerCalls('emails')).filter((c) => c.body.to === order.email).map((c) => c.body.template);
    expect(emails).toEqual(['order_paid', 'order_refunded']);
    expect((await stack.providerCalls('shipments')).some((c) => c.body.orderId === order.orderId)).toBe(false);
  });

  it('E10: retries transient provider failures without double-charging', async () => {
    await stack.script({ route: 'charges', status: 503, times: 2 });
    const order = newOrder();
    await stack.api('/orders', { body: order });
    await waitForStatus(stack, order.orderId, 'completed');
    const charges = (await stack.providerCalls('charges')).filter((c) => c.idempotencyKey === `charge-${order.orderId}`);
    expect(charges.map((c) => c.status)).toEqual([503, 503, 201]);
  });

  it('E17: carries the request correlation ID to the provider', async () => {
    const order = newOrder();
    const created = await stack.api('/orders', { body: order, headers: { 'x-correlation-id': 'e2e-corr-17' } });
    expect(created.headers.get('x-correlation-id')).toBe('e2e-corr-17');
    await waitForStatus(stack, order.orderId, 'completed');
    const calls = (await stack.providerCalls()).filter((c) => c.body.orderId === order.orderId || c.body.to === order.email);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call.correlationId).toBe('e2e-corr-17');
  });
});

describe('sad paths', () => {
  it('E2: rejects a duplicate order with 409', async () => {
    const order = newOrder({ cancelWindow: '1 minute' });
    expect((await stack.api('/orders', { body: order })).status).toBe(201);
    const dup = await stack.api('/orders', { body: order });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'WORKFLOW_ALREADY_STARTED', details: { workflowId: `order-${order.orderId}` } });
    await stack.api(`/orders/${order.orderId}/cancel`, { body: {} });
  });

  it('E3: unknown orders are 404 for reads, updates and signals', async () => {
    const ghost = uid('ghost');
    for (const [path, body] of [
      [`/orders/${ghost}`, undefined],
      [`/orders/${ghost}/items`, { sku: 'sku-book', qty: 1 }],
      [`/orders/${ghost}/cancel`, { reason: 'x' }],
      [`/customers/${ghost}/loyalty`, undefined],
    ] as const) {
      const res = await stack.api(path, { body });
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
    }
  });

  it('E5: rejects invalid items with 422 and bad requests with 400', async () => {
    const cartId = uid('cart');
    const buyer = { customerId: uid('cust'), email: 'x@example.com', card: 'tok_visa' };
    expect((await stack.api(`/carts/${cartId}/items`, { body: { ...buyer, sku: 'sku-book', qty: 1 } })).status).toBe(200);
    const unknown = await stack.api(`/orders/${cartId}/items`, { body: { sku: 'sku-nope', qty: 1 } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'UPDATE_REJECTED', details: { failureType: 'InvalidItemError', update: 'addItem' } });
    const qty = await stack.api(`/orders/${cartId}/items`, { body: { sku: 'sku-book', qty: 0 } });
    expect(qty.status).toBe(422);
    expect((await stack.api('/orders', { body: { orderId: uid('o') } })).status).toBe(400);
    expect((await stack.api(`/orders/${cartId}`)).body.items).toEqual([{ sku: 'sku-book', qty: 1 }]);
    // An empty cart can't be submitted either.
    const empty = uid('cart');
    await stack.api(`/carts/${empty}/items`, { body: { ...buyer, sku: 'sku-book', qty: 1 } });
    await stack.api(`/orders/${empty}/cancel`, { body: {} });
    const late = await stack.api(`/orders/${empty}/submit`, { method: 'POST' });
    expect([409, 422]).toContain(late.status);
    await stack.api(`/orders/${cartId}/cancel`, { body: {} });
  });

  it('E8: cancelling a completed order is 409 WORKFLOW_CLOSED', async () => {
    const order = newOrder();
    await stack.api('/orders', { body: order });
    await waitForStatus(stack, order.orderId, 'completed');
    const late = await stack.api(`/orders/${order.orderId}/cancel`, { body: { reason: 'late' } });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'WORKFLOW_CLOSED', details: { closeStatus: 'COMPLETED' } });
  });

  it('E11: a declined card fails once, releases stock and emails the customer', async () => {
    const order = newOrder({ card: 'card_declined' });
    await stack.api('/orders', { body: order });
    const failed = await waitForStatus(stack, order.orderId, 'payment_failed');
    expect(failed.failure).toBe('insufficient funds');
    const charges = (await stack.providerCalls('charges')).filter((c) => c.body.orderId === order.orderId);
    expect(charges.map((c) => c.status)).toEqual([402]);
    const emails = (await stack.providerCalls('emails')).filter((c) => c.body.to === order.email).map((c) => c.body.template);
    expect(emails).toEqual(['payment_failed']);
  });
});

describe('webhooks', () => {
  it('signals a dispute into the order, ignores duplicates and late deliveries, and rejects bad signatures', async () => {
    const order = newOrder({ cancelWindow: '1 minute' });
    await stack.api('/orders', { body: order });
    const paid = await waitForStatus(stack, order.orderId, 'paid');
    const event = { id: uid('evt'), type: 'charge.disputed', data: { orderId: order.orderId, chargeId: paid.chargeId } };

    const forged = await stack.sendWebhook(event, 'wrong-secret');
    expect(forged.status).toBe(401);

    const delivered = await stack.sendWebhook(event);
    expect(delivered).toMatchObject({ status: 202, body: { accepted: 1 } });
    await waitForStatus(stack, order.orderId, 'charged_back');

    // The provider retries; the order is closed by now, so the delivery is acknowledged and ignored.
    const retry = await stack.sendWebhook(event);
    expect(retry).toMatchObject({ status: 200, body: { ignored: 'closed' } });

    const unrelated = await stack.sendWebhook({ id: uid('evt'), type: 'charge.succeeded', data: {} });
    expect(unrelated.status).toBe(202);
    expect(unrelated.body).toMatchObject({ accepted: 0 });
  });
});
