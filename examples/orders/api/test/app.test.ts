// API tests with the fake client: no Temporal server, but the same 404/409/422 behavior.
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createFakeClient } from '@norn-ts/testing';
import { UpdateRejectedError } from '@norn-ts/core';
import { OrderWorkflow } from '@norn/example-orders-contracts';
import { createApp } from '../src/app.ts';

const setup = () => {
  const fake = createFakeClient();
  const app = createApp({ client: fake, webhookSecret: 'shh' });
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };
  return { fake, call };
};

const order = { orderId: 'o-1', customerId: 'c-1', email: 'a@b.c', card: 'tok', items: [{ sku: 'sku-book', qty: 1 }] };

describe('orders API', () => {
  it('starts orders with typed search attributes', async () => {
    const { fake, call } = setup();
    const res = await call('/orders', order);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ orderId: 'o-1', workflowId: 'order-o-1' });
    expect(fake.calls[0]).toMatchObject({ op: 'start', workflow: 'OrderWorkflow', options: { searchAttributes: { CustomerId: 'c-1' } } });
  });

  it('returns 409 for duplicates, 404 for unknown orders and 400 for bad bodies', async () => {
    const { call } = setup();
    await call('/orders', order);
    expect((await call('/orders', order)).body.error.code).toBe('WORKFLOW_ALREADY_STARTED');
    expect((await call('/orders/missing')).status).toBe(404);
    expect((await call('/orders', { orderId: 'x' })).status).toBe(400);
    const notJson = await (await import('../src/app.ts')).createApp({ client: createFakeClient(), webhookSecret: 's' }).request('/orders', { method: 'POST', body: '{' });
    expect(notJson.status).toBe(400);
  });

  it('returns 400 for quantities outside 1-100 without starting anything', async () => {
    const { fake, call } = setup();
    for (const qty of [-2, 0, 1.5, 101, '2', undefined]) {
      expect((await call('/orders', { ...order, items: [{ sku: 'sku-book', qty }] })).status).toBe(400);
      expect((await call('/carts/c-1/items', { customerId: 'c-1', email: 'a@b.c', card: 'tok', sku: 'sku-book', qty })).status).toBe(400);
      expect((await call('/orders/o-1/items', { sku: 'sku-book', qty })).status).toBe(400);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('maps rejected updates to 422', async () => {
    const { fake, call } = setup();
    fake.stub(OrderWorkflow, {
      updates: {
        addItem: () => {
          throw new UpdateRejectedError({ workflowId: 'order-o-1', update: 'addItem', failureType: 'InvalidItemError', message: 'Unknown SKU' });
        },
      },
    });
    await call('/orders', order);
    const res = await call('/orders/o-1/items', { sku: 'nope', qty: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'UPDATE_REJECTED', message: 'Unknown SKU' });
  });

  it('returns 409 when cancelling a finished order', async () => {
    const { fake, call } = setup();
    await call('/orders', order);
    fake.complete('order-o-1', {});
    const res = await call('/orders/o-1/cancel', { reason: 'late' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKFLOW_CLOSED');
  });

  it('verifies and maps payment webhooks', async () => {
    const { fake, call } = setup();
    await call('/orders', order);
    const event = { id: 'evt_1', type: 'charge.disputed', data: { orderId: 'o-1', chargeId: 'ch_1' } };
    const raw = JSON.stringify(event);
    const sig = `sha256=${createHmac('sha256', 'shh').update(raw).digest('hex')}`;
    expect((await call('/webhooks/payments', event, { 'x-provider-signature': 'sha256=00' })).status).toBe(401);
    const ok = await call('/webhooks/payments', event, { 'x-provider-signature': sig });
    expect(ok.status).toBe(202);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'signal', name: 'paymentEvent', args: [{ eventId: 'evt_1', type: 'charge.disputed', chargeId: 'ch_1' }] });
  });

  it('echoes correlation IDs', async () => {
    const { call } = setup();
    const res = await call('/orders', order, { 'x-correlation-id': 'req-123' });
    expect(res.headers.get('x-correlation-id')).toBe('req-123');
  });
});
