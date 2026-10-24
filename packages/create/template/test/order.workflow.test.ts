import { expect, it, vi } from 'vitest';
import { useTestEnv } from '@norn-ts/norn/vitest';
import { OrderWorkflow } from '../src/workflows/order.workflow';

const payments = {
  charge: vi.fn(async (orderId: string, cents: number) => ({ id: `ch_${orderId}`, cents })),
  refund: vi.fn(async (_chargeId: string) => true),
};

// One time-skipping Temporal server and worker for this file. The first run downloads the server.
const env = useTestEnv({
  workflows: new URL('../src/workflows/index.ts', import.meta.url),
  activities: { payments },
  mode: 'time-skipping',
});

it('keeps the charge when nobody cancels', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500 });
  // The 5 minute window passes instantly on the time-skipping server.
  expect(await order.result()).toBe('paid');
  expect(payments.charge).toHaveBeenCalledWith('o-1', 500);
  expect(payments.refund).not.toHaveBeenCalled();
});

it('refunds when canceled within the window', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-2', cents: 500 });
  await order.signal('cancel', 'test');
  expect(await order.result()).toBe('refunded');
  expect(payments.refund).toHaveBeenCalledWith('ch_o-2');
});

it('reports its status while it waits', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-3', cents: 500 });
  await expect.poll(() => order.query('getStatus')).toBe('paid');
  await order.signal('cancel', 'test');
  await order.result();
});
