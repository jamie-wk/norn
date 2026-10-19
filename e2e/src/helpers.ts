import { expect } from 'vitest';
import type { Stack } from './stack.ts';

let counter = 0;
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const customer = () => ({ customerId: uid('cust'), email: `${uid('buyer')}@example.com` });

export function newOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: uid('ord'),
    ...customer(),
    card: 'tok_visa',
    items: [
      { sku: 'sku-book', qty: 2 },
      { sku: 'sku-mug', qty: 1 },
    ],
    cancelWindow: '1s',
    ...overrides,
  };
}

/** Polls GET /orders/:id until the order reaches `status`. */
export async function waitForStatus(stack: Stack, orderId: string, status: string, timeout = 45_000) {
  let last: unknown;
  await expect
    .poll(
      async () => {
        const res = await stack.api(`/orders/${orderId}`);
        last = res.body;
        return res.body?.status;
      },
      { timeout, interval: 250 },
    )
    .toBe(status);
  return last as Record<string, any>;
}
