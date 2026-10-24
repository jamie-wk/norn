---
title: 2. Change the address
description: Let callers change a running order's address with an update, and reject bad changes with a validator before anything is recorded.
sidebar:
  order: 2
---

Customers move, and typos happen. While an order waits out its cancellation window, the customer should be able to change the shipping address. Once the parcel is with the carrier, they shouldn't.

You have seen two ways to talk to a running workflow: a **signal** (fire and forget, as with `cancel`) and a **query** (read-only, as with `getStatus`). Changing the address needs a third: an **update**. An update changes the workflow's state, *and* the caller waits for the result, so it learns whether the change was accepted. A **validator** can reject an update before it is accepted, and then nothing is written to the history at all.

## Keep the address in workflow state

So far the workflow ships to `input.address`. An update needs somewhere to write, so keep the address in a field, and set it in the **constructor**:

```ts
private address: Address;

constructor(input: OrderInput) {
  // Set up state here, not in run(): an update can arrive before run() starts.
  this.address = input.address;
}
```

Norn passes the workflow input to the constructor as well as to `run()`. An update or signal can be delivered in the very first workflow task, before `run()` has executed a single line, and anything set up in the constructor is guaranteed to be ready by then.

Then ship to `this.address` instead of `input.address`:

```ts
await this.shipping.ship(input.orderId, this.address);
```

## The update and its validator

```ts
// src/workflows/order.workflow.ts
import { Query, Signal, Update, Validate, Workflow, asFailure, useActivities } from '@norn-ts/workflow';

export class OrderLockedError extends Error {
  override name = 'OrderLockedError';
}

export class InvalidAddressError extends Error {
  override name = 'InvalidAddressError';
}

// in the OrderWorkflow class:

  @Validate('changeAddress') checkAddress(address: Address) {
    if (this.status !== 'pending' && this.status !== 'paid') throw new OrderLockedError(`The order is already ${this.status}`);
    if (!address.street || !address.city || !address.country) throw new InvalidAddressError('The address is incomplete');
  }

  @Update() changeAddress(address: Address): Address {
    this.address = address;
    return this.address;
  }
```

- `@Validate('changeAddress')` registers `checkAddress` as the validator for the `changeAddress` update. The name is type-checked: a typo, or a validator whose parameters don't match the update's, doesn't compile.
- Validators must be synchronous and must not change state. If one throws, the caller gets an `UpdateRejectedError` and the workflow's history doesn't change at all.
- The error classes are defined in the workflow file. That's fine: they are plain classes, safe in the sandbox.
- The `'shipping'` status from the previous chapter is what locks the address: once `run()` sets it and calls the carrier, changes are refused.

## Test it

Add two tests to `test/order.workflow.test.ts`, and import the error classes the client throws:

```ts
import { UpdateRejectedError, WorkflowClosedError } from '@norn-ts/client';

it('ships to the address from the latest update', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-4', cents: 500, address });
  const moved = { ...address, street: '2 Elm St' };
  expect(await order.update('changeAddress', moved)).toEqual(moved);
  expect(await order.result()).toBe('shipped');
  expect(shipping.ship).toHaveBeenCalledWith('o-4', moved);
});

it('rejects an incomplete address without touching the workflow', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-5', cents: 500, address });
  await expect(order.update('changeAddress', { ...address, city: '' })).rejects.toThrow(UpdateRejectedError);
  expect(await order.result()).toBe('shipped');
  expect(shipping.ship).toHaveBeenCalledWith('o-5', address);
});

it('refuses updates once the order is finished', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-6', cents: 500, address });
  await order.result();
  await expect(order.update('changeAddress', address)).rejects.toThrow(WorkflowClosedError);
});
```

```sh
pnpm test
```

```text
      Tests  6 passed (6)
```

`order.update('changeAddress', moved)` is typed from the workflow class: the update's name, its argument and its result (`Address`) all come from the contract that `norn gen` wrote. Try passing a number instead of an address, or misspelling `changeAddress`. Neither compiles.

The last test shows a difference between the two kinds of failure. A **rejected** update (`UpdateRejectedError`) means the workflow said no. A **closed** workflow (`WorkflowClosedError`) means there was nobody left to ask. In the next chapter, an HTTP API maps them to different status codes.

Next: [add an HTTP API](/norn/tutorial/3-http-api/).
