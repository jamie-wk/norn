# Signals, queries & updates

Workflows talk to the outside world through three kinds of messages. In Norn each is a decorated method on the workflow class:

| | Decorator | Returns a value | Can change state | Can await | Caller waits for |
| --- | --- | --- | --- | --- | --- |
| **Signal** | `@Signal()` | no | yes | yes | the server to accept it |
| **Query** | `@Query()` | yes | **no** | **no** | the answer |
| **Update** | `@Update()` | yes | yes | yes | the handler to finish |

```ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow } from '@norn-ts/workflow';

export class OrderStateError extends Error {
  override name = 'OrderStateError';
}

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private readonly items: { sku: string; qty: number }[] = [];
  private submitted = false;
  private cancelReason: string | undefined;

  /** Cancel the order. */
  @Signal() cancel(reason: string) {
    this.cancelReason ??= reason;
  }

  @Query() view() {
    return { items: this.items, submitted: this.submitted, canceled: this.cancelReason !== undefined };
  }

  @Validate('addItem') checkItem(item: { sku: string; qty: number }) {
    if (this.submitted) throw new OrderStateError('Order is already submitted');
    if (item.qty < 1) throw new OrderStateError('qty must be at least 1');
  }

  /** Add an item and return the new item count. */
  @Update() addItem(item: { sku: string; qty: number }) {
    this.items.push(item);
    return this.items.length;
  }

  @Update() submit() {
    this.submitted = true;
  }

  async run(_input: { orderId: string }) {
    await condition(() => this.submitted || this.cancelReason !== undefined);
    // ...
  }
}
```

From a client, you call handlers by **method name**, with typed arguments and results:

```ts
const order = norn.workflow(OrderWorkflow).get({ orderId: 'o-1' });
// number
const count = await order.update('addItem', { sku: 'sku-mug', qty: 2 });
await order.signal('cancel', 'customer request');
// typed from the method's return type
const view = await order.query('view');
```

JSDoc comments on handler methods become their descriptions in the Temporal UI (`norn gen` passes them to `implement()`), or set `description` explicitly in the options.

## Names

A handler's registered name defaults to the method name. Pass a string, or `{ name }`, to register it under a different name, for example to keep a wire name stable while you rename the method, or to match a non-TypeScript caller:

```ts
@Query('status') getStatus() { /* registered as "status" */ }
@Signal({ name: 'transfer-event' }) transferEvent(e: TransferEvent) { /* registered as "transfer-event" */ }
```

TypeScript callers still use the method name (`handle.query('getStatus')`); the contract maps it to the registered name. Each kind has its own namespace, and two methods registering the same name is a definition-time error. Registered names are recorded in [`norn.lock.json`](/guide/project-layout#norn-lock-json-rename-protection), because renaming one breaks callers of running executions.

## Signals

A signal is a fire-and-forget message. The caller returns as soon as the server has durably recorded it; the handler runs on the next workflow task. Signal handlers can be async and call activities, but usually they just record what happened and let `run()` react.

### Options

```ts
@Signal({
  // registered name; defaults to the method name
  name: 'payment-event',
  // shown in the Temporal UI
  description: 'Provider webhooks',
  // see "Unfinished handlers"
  unfinishedPolicy: 'abandon',
  dedupeBy: (event: PaymentEvent) => event.eventId,
})
paymentEvent(event: PaymentEvent) { /* ... */ }
```

### `dedupeBy`: at-least-once sources

Webhooks and message queues deliver at least once. `dedupeBy` receives the signal's arguments and returns a key; a signal whose key was already seen in this run is dropped before your handler runs. Returning `undefined` skips deduplication for that signal.

```ts
@Signal({ dedupeBy: (e: { eventId: string }) => e.eventId })
transferEvent(e: { eventId: string; status: string }) {
  this.events.push(e);
}
```

The seen keys live in workflow memory **for the current run only**. They are rebuilt on replay (the same signals arrive in the same order), but they do not survive [continue-as-new](/guide/long-running). If duplicates can arrive across runs, carry the recent keys in the continue-as-new input and check them yourself, as the loyalty example does.

## Queries

A query reads state. Query handlers must be **synchronous** and must not change state, because they run outside the workflow's history and may run on any replica at any time. Norn enforces the synchronous part twice: an `async` query method fails to type-check (`Query handlers must be synchronous`), and `@Query` throws at definition time if the method is async.

```ts
@Query() view(): OrderView {
  return { status: this.status.current, items: this.items.map((i) => ({ ...i })) };
}
```

Return copies of mutable state rather than the arrays themselves. Queries can take arguments:

```ts
@Query() item(sku: string) {
  return this.items.find((i) => i.sku === sku);
}
// client: await handle.query('item', 'sku-mug')
```

## Updates

An update is a tracked request: the caller waits until the handler finishes and gets its return value (or its error). Updates are the right tool when the caller needs to know the outcome: "add this item and tell me the new total", "cancel the payment, or tell me why you can't".

Update handlers can be async. The caller waits for the whole handler, so an update can wait for workflow progress:

```ts
/** Submits the order and resolves once payment has succeeded or failed. */
@Update() async submit(): Promise<OrderView> {
  this.submitted = true;
  await condition(() => this.status.is('paid', 'payment_failed'));
  return this.view();
}
```

Options are `name`, `description` and `unfinishedPolicy`.

### Validators

`@Validate('methodName')` registers a validator for an update. Validators run **before** the update is accepted; if one throws, the update is rejected and **nothing is written to history**: no event, no state change. Use them for every precondition you can check up front.

```ts
@Validate('changeTerms') checkTerms(change: TermsChange) {
  if (!this.status.is('pending')) throw new InvitationClosedError(`Invitation is ${this.status.current}`);
  if (change.rateCents <= 0) throw new InvalidTermsError('rate must be positive');
}

@Update() changeTerms(change: TermsChange) {
  this.terms = { ...this.terms, ...change };
  return this.terms;
}
```

Rules, all checked:

- The name must refer to an `@Update` method of the class. A typo fails to type-check; naming a signal fails `norn gen` and throws when the workflow is loaded.
- The validator's parameters must match the update's (type-checked).
- Validators must be synchronous and must not change state.
- One validator per update.

On the client, a rejected update throws `UpdateRejectedError` (HTTP 422) with the error's type in `failureType`. The same happens when the update handler itself throws an `ApplicationFailure`, or an error listed in the workflow's `failOn`. Throwing any other error from an update *handler* (not the validator) fails the workflow task, just like in `run()`, so prefer validators for anything that can be rejected.

### Update-with-start

Clients can run an update and start the workflow in one call, if it isn't running yet. This is ideal for "add to cart" style flows where the first interaction creates the workflow:

```ts
const { handle, result } = await norn.workflow(CartWorkflow).updateWithStart(
  // input, used only if the workflow has to start
  { cartId: 'c-9' },
  { update: 'add', args: ['sku-mug'] },
);
```

The constructor runs before the first update handler, so state set up there is ready. See [Client](/guide/client#with-start-operations).

## Unfinished handlers

With the default `drainHandlers: true`, a workflow waits for all in-flight async signal and update handlers before completing, and `continueAsNew()` does the same, so nothing is cut off. `unfinishedPolicy` only matters when a handler is still running at completion anyway: with `drainHandlers: false`, after `continueAsNew(input, { waitForHandlers: false })`, or when the workflow fails.

- `'warn'` (default): Temporal logs a warning that the handler was abandoned.
- `'abandon'`: abandon it silently; use it for handlers where that is expected.

## Messages to other workflows

From inside a workflow, signal or cancel another workflow with [`useExternal()`](/guide/child-workflows#external-workflows), and signal children through their handles. Both are typed by method name, the same way as the client.
