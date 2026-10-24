---
title: 1. Ship the order
description: Add a shipping activity with an injected service, retries and a non-retryable error, and refund the customer when shipping fails.
sidebar:
  order: 1
---

Once the cancellation window has passed, the order should ship. Shipping talks to a carrier, which is I/O, so it belongs in an **activity**. The carrier can also refuse an address, and when it does, the customer should get their money back. That's **compensation**: undoing an earlier step when a later one fails.

## A shipping service

Activities reach the outside world through services. As with the payment gateway in the starter, declare the service as an interface plus a **token** with the same name, so activities can ask for it by type. Then write a stand-in implementation:

```ts
// src/services/shipping.ts
import { Service, token } from '@norn-ts/activity';

export interface Address {
  name: string;
  street: string;
  city: string;
  country: string;
}

export class AddressRejectedError extends Error {
  override name = 'AddressRejectedError';
}

export interface ShippingService {
  createShipment(request: { orderId: string; address: Address }): Promise<{ trackingNumber: string }>;
}
export const ShippingService = token<ShippingService>('ShippingService');

/** A stand-in carrier that only ships to a few countries. */
@Service({ provides: ShippingService })
export class FakeShippingService implements ShippingService {
  async createShipment(request: { orderId: string; address: Address }) {
    if (!['US', 'CA', 'GB'].includes(request.address.country)) {
      throw new AddressRejectedError(`We don't ship to ${request.address.country}`);
    }
    console.log(`shipping ${request.orderId} to ${request.address.city}`);
    return { trackingNumber: `TRK-${request.orderId}` };
  }
}
```

The error class sets `name` explicitly. Temporal identifies failures by their type name, and an explicit name survives minification.

## The activity

```ts
// src/activities/shipping.activities.ts
import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { AddressRejectedError, ShippingService, type Address } from '../services/shipping';

@Activities({ prefix: 'shipping.' })
export class ShippingActivities {
  constructor(private readonly shipping: ShippingService) {}

  @Activity({ timeout: '1m', retries: 5 })
  @NonRetryable([AddressRejectedError])
  async ship(orderId: string, address: Address) {
    return this.shipping.createShipment({ orderId, address });
  }
}
```

- `retries: 5` means that if the carrier times out or returns an error, Temporal tries again, up to five more times, with exponential backoff. Your code doesn't contain a single retry loop.
- `@NonRetryable([AddressRejectedError])` says that retrying won't help with this error. The activity fails straight away, and the workflow decides what to do.
- The constructor asks for a `ShippingService`. When you save, `norn gen` sees that type, finds the `@Service` that provides it, and writes the wiring into `.norn/container.ts`.

## Ship from the workflow

Now update the workflow. The input gains an address, and after the cancellation window the order ships, or is refunded if the carrier refuses it:

```ts ins={3,4,5,10,13,23,33,35,36,37,38,39,40,41,42,43,44,45}
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, asFailure, useActivities } from '@norn-ts/workflow';
import { PaymentActivities, ShippingActivities } from '../../.norn/activities';
import type { Address } from '../services/shipping';

export interface OrderInput {
  orderId: string;
  cents: number;
  address: Address;
}

export type OrderStatus = 'pending' | 'paid' | 'shipping' | 'shipped' | 'refunded';

/** How long a paid order can still be canceled (and refunded). */
const cancellationWindow = '5 minutes';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: OrderStatus = 'pending';
  private canceled = false;
  private readonly payments = useActivities(PaymentActivities);
  private readonly shipping = useActivities(ShippingActivities);

  // cancel() and getStatus() are unchanged

  async run(input: OrderInput): Promise<OrderStatus> {
    const charge = await this.payments.charge(input.orderId, input.cents);
    this.status = 'paid';
    if (await condition(() => this.canceled, cancellationWindow)) {
      await this.payments.refund(charge.id);
      this.status = 'refunded';
      return this.status;
    }

    this.status = 'shipping';
    try {
      await this.shipping.ship(input.orderId, input.address);
      this.status = 'shipped';
    } catch (error) {
      // Only a rejected address is expected; anything else fails the workflow as usual.
      if (!asFailure(error, 'AddressRejectedError')) throw error;
      await this.payments.refund(charge.id);
      this.status = 'refunded';
    }
    return this.status;
  }
}
```

Three things are worth noticing:

- **The workflow imports `ShippingActivities` from `.norn/activities`**, the generated, workflow-safe reference, just as it does for payments. Calling `this.shipping.ship()` schedules the activity on the worker. The workflow never runs the carrier code itself.
- **`asFailure(error, 'AddressRejectedError')`** looks through the activity failure for the original error's type. It takes the name as a string so that the workflow doesn't import `AddressRejectedError` from the service module, which would pull activity code into the [workflow sandbox](/norn/concepts/determinism/). `norn gen` would flag that import if you tried.
- **The compensation is ordinary code.** There is no saga framework: a `try`/`catch` and a refund. If the worker crashes in the middle, Temporal replays the history and the `catch` runs exactly as it would have.

## Follow the compiler

Save, and `pnpm dev` regenerates `.norn/`. Now run the type checker:

```sh
pnpm typecheck
```

```text
src/order.ts(14,36): error TS2741: Property 'address' is missing in type '{ orderId: string; cents: number; }' but required in type 'OrderInput'.
test/order.workflow.test.ts(16,57): error TS2741: Property 'address' is missing ...
```

The input changed, and every place that starts the workflow is now a compile error, including the client script, which only knows the workflow through its generated contract. Fix `src/order.ts` first:

```ts ins={1}
const address = { name: 'Ada Lovelace', street: '12 St James Sq', city: 'London', country: process.env.COUNTRY ?? 'GB' };
const order = await orders.start({ orderId, cents: 1999, address });
```

## Update the tests

Replace `test/order.workflow.test.ts`. The shipping mock rejects one country, so the compensation path can be tested without a real carrier:

```ts
// test/order.workflow.test.ts
import { expect, it } from 'vitest';
import { mockActivities, useTestEnv } from '@norn-ts/testing/vitest';
import { PaymentActivities, ShippingActivities } from '../.norn/activities';
import { OrderWorkflow } from '../.norn/contracts';
import { registry } from '../.norn/registry';
import { AddressRejectedError, type Address } from '../src/services/shipping';

const payments = mockActivities(PaymentActivities, {
  charge: async (orderId, cents) => ({ id: `ch_${orderId}`, cents }),
  refund: async () => true,
});
const shipping = mockActivities(ShippingActivities, {
  ship: async (orderId, address) => {
    if (address.country === 'AQ') throw new AddressRejectedError('no penguins');
    return { trackingNumber: `TRK-${orderId}` };
  },
});

const address: Address = { name: 'Ada', street: '1 Main St', city: 'Springfield', country: 'US' };

const env = useTestEnv({ registry, mode: 'time-skipping', activities: [payments, shipping] });

it('ships when nobody cancels', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500, address });
  expect(await order.result()).toBe('shipped');
  expect(shipping.ship).toHaveBeenCalledWith('o-1', address);
  expect(payments.refund).not.toHaveBeenCalled();
});

it('refunds when canceled within the window', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-2', cents: 500, address });
  await order.signal('cancel', 'test');
  expect(await order.result()).toBe('refunded');
  expect(payments.refund).toHaveBeenCalledWith('ch_o-2');
  expect(shipping.ship).not.toHaveBeenCalledWith('o-2', address);
});

it('refunds when the carrier rejects the address', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-3', cents: 500, address: { ...address, country: 'AQ' } });
  expect(await order.result()).toBe('refunded');
  expect(payments.refund).toHaveBeenCalledWith('ch_o-3');
});
```

```sh
pnpm test
```

```text
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

The worker logs a stack trace for the rejected address. That's expected: it is the activity failing, which is exactly what the third test checks.

`mockActivities()` is typed against the real activity class, so a mock with the wrong parameters or return type doesn't compile, and each mock is a spy you can assert on.

## Try it

With `pnpm dev` running, start two orders, one of them to a country the carrier refuses:

```sh
pnpm order
COUNTRY=AQ pnpm order
```

After five minutes, the first ships (the worker logs `shipping ... to London`) and the second is refunded. Open both in the Web UI to compare their histories. The second shows `shipping.ship` failing once, without retries, followed by `payments.refund`.

Next: [let customers change the address](/norn/tutorial/2-updates/).
