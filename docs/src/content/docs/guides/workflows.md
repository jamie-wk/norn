---
title: "Workflows"
description: Workflow classes, signals, queries and updates, timers, child workflows, continue-as-new, search attributes and failures.
---

A Norn workflow is a class decorated with `@Workflow`. Its `run()` method is the workflow's main line, its decorated methods handle signals, queries and updates, and its fields are the workflow's state.

```ts
import { sleep } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn-ts/norn/workflow';
import type { NotifyActivities } from '../activities/notify.activities';

export interface ReminderInput {
  userId: string;
  email: string;
}

@Workflow({ taskQueue: 'reminders', id: 'reminder-{userId}' })
export class ReminderWorkflow {
  private snoozed = 0;
  private readonly notify = useActivities<NotifyActivities>('notify', { timeout: '30s' });

  @Signal() snooze() {
    this.snoozed++;
  }

  @Query() status() {
    return { snoozed: this.snoozed };
  }

  async run(input: ReminderInput) {
    await sleep('1 day');
    while (this.snoozed > 0) {
      this.snoozed--;
      await sleep('1 hour');
    }
    return this.notify.email(input.email, 'Your reminder');
  }
}
```

Export every workflow class from one module, such as `src/workflows/index.ts`, and hand that module to the [worker](/norn/guides/worker/):

```ts
// src/workflows/index.ts
export { ReminderWorkflow } from './reminder.workflow';
export { OrderWorkflow } from './order.workflow';
```

## Lifecycle of an execution

For every execution, and on every replay, Norn does exactly this:

1. **Constructs the class with the workflow input**: `new ReminderWorkflow(input)`. Field initializers run here too, including `useActivities()`.
2. **Registers every signal, query and update handler**, before any of them can be delivered.
3. **Calls `run(input)`** and awaits it.
4. **Waits for in-flight handlers to finish** (unless `drainHandlers: false`), so an async signal or update handler that is still awaiting an activity isn't cut off.
5. Returns `run()`'s result as the workflow result.

Handlers can run before `run()` gets anywhere: with update-with-start, or when a signal arrives in the first workflow task. Set up state in the constructor so handlers always see it:

```ts
@Workflow({ taskQueue: 'carts', id: 'cart-{cartId}' })
export class CartWorkflow {
  private readonly items: string[];

  constructor(input: { cartId: string; seed?: string[] }) {
    this.items = [...(input.seed ?? [])];
  }

  @Update() add(sku: string) {
    this.items.push(sku);
    return { count: this.items.length };
  }

  async run(_input: { cartId: string; seed?: string[] }) {
    // ...
  }
}
```

Constructors must be synchronous and must not schedule activities or timers. The constructor parameter and `run()`'s parameter are the same value; declare the type on both (the client's input type comes from `run()`).

## `@Workflow` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `taskQueue` | `string` | required | Task queue the workflow runs on. Workers poll it; clients start it there. |
| `name` | `string` | class name | Temporal workflow type. Must be a valid identifier. |
| `id` | `string` | none | Workflow ID template, such as `'order-{orderId}'`. Placeholders are fields of `run()`'s input. |
| `versioning` | `'pinned'` or `'auto-upgrade'` | worker default | Worker-versioning behavior for this workflow type. |
| `searchAttributes` | `Record<string, SearchAttributeType>` | `{}` | Custom search attributes the workflow sets, with their types. |
| `failOn` | error classes | `[]` | Errors that fail the workflow (or the update) instead of retrying the workflow task. |
| `drainHandlers` | `boolean` | `true` | Wait for in-flight signal and update handlers before completing. |

### ID templates

An `id` template turns business keys into workflow IDs, so callers never build ID strings by hand and the same order can't run twice by accident:

```ts
@Workflow({ taskQueue: 'payments', id: 'payment-{paymentId}' })
export class PaymentWorkflow {
  async run(input: { paymentId: string; amountCents: number }) { /* ... */ }
}

// Client side: ID "payment-p_123", no string building
await norn.workflow(PaymentWorkflow).start({ paymentId: 'p_123', amountCents: 5_000 });
norn.workflow(PaymentWorkflow).get({ paymentId: 'p_123' });
```

Templates are checked at compile time. If a placeholder isn't a field of `run()`'s input, the decorator fails to type-check:

```ts
// error: ID template field "orderId" is not a field of run()'s input
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class BadIdWorkflow {
  async run(input: { id: string }) {}
}
```

At runtime, placeholder values must be non-empty strings, numbers or bigints; anything else throws a `NornConfigError` before the call reaches Temporal. Templates may use several fields (`'invoice-{companyId}-{invoiceNumber}'`). Without a template, callers pass `{ workflowId }` explicitly.

## Signals

A signal is a fire-and-forget message. The caller returns as soon as the server has durably recorded it, and the handler runs on the next workflow task. Signal handlers can be async and call activities, but usually they just record what happened and let `run()` react.

```ts
@Signal() cancel(reason: string) {
  this.cancelReason ??= reason;
}
```

Options:

```ts
@Signal({
  name: 'payment-event',          // registered name; defaults to the method name
  description: 'Provider webhooks', // shown in the Temporal UI
  unfinishedPolicy: 'abandon',    // see "Unfinished handlers"
  dedupeBy: (event: PaymentEvent) => event.eventId,
})
paymentEvent(event: PaymentEvent) { /* ... */ }
```

`dedupeBy` is for at-least-once sources such as webhooks and queues. It receives the signal's arguments and returns a key, and a signal whose key was already seen in this run is dropped before your handler runs. Returning `undefined` skips deduplication. The seen keys last for the current run only; carry them in the [continue-as-new](#long-running-workflows) input if duplicates can arrive across runs.

## Queries

A query reads state. Query handlers must be **synchronous** and must not change state, because they run outside the workflow's history. An `async` query fails to type-check, and `@Query` throws if the method is async.

```ts
@Query() view(): OrderView {
  return { status: this.status, items: this.items.map((i) => ({ ...i })) };
}

@Query() item(sku: string) {
  return this.items.find((i) => i.sku === sku);
}
```

Return copies of mutable state rather than the arrays themselves.

## Updates

An update is a tracked request: the caller waits until the handler finishes and gets its return value or its error. Use one when the caller needs the outcome: "add this item and tell me the new total".

```ts
@Validate('addItem') checkItem(item: { sku: string; qty: number }) {
  if (this.submitted) throw new OrderStateError('Order is already submitted');
  if (item.qty < 1) throw new OrderStateError('qty must be at least 1');
}

@Update() addItem(item: { sku: string; qty: number }) {
  this.items.push(item);
  return this.items.length;
}

/** Submits the order and resolves once payment has succeeded or failed. */
@Update() async submit(): Promise<OrderView> {
  this.submitted = true;
  await condition(() => this.status === 'paid' || this.status === 'payment_failed');
  return this.view();
}
```

`@Validate('method')` runs **before** the update is accepted. If it throws, the update is rejected and nothing is written to history. Validators must be synchronous, take the same parameters as the update (type-checked), and there's one per update. On the client, a rejected update throws `UpdateRejectedError` with the error's `name` in `failureType`. The same happens when the update handler itself throws an `ApplicationFailure` or an error listed in `failOn`; any other error from the handler fails the workflow task, so prefer validators for anything that can be rejected.

Options are `name`, `description` and `unfinishedPolicy`.

### Unfinished handlers

With the default `drainHandlers: true`, a workflow waits for in-flight async signal and update handlers before completing, and `continueAsNew()` does the same. `unfinishedPolicy` only matters when a handler is still running at completion anyway (with `drainHandlers: false`, or when the workflow fails): `'warn'` (the default) logs a warning, and `'abandon'` drops it silently.

### Handler names

A handler's registered name defaults to the method name. Pass a string or `{ name }` to register it under another name, for example to keep a wire name stable while you rename the method. TypeScript callers still use the method name; Norn maps it. Registered names are what running executions and their callers depend on, so keep them stable.

## Timers and waiting

Use the SDK's primitives directly:

```ts
import { condition, sleep } from '@temporalio/workflow';

await sleep('3 days'); // a durable timer: survives worker restarts and deploys
const approved = await condition(() => this.approved, '48 hours'); // false on timeout
await condition(() => this.items.length > 0); // no timeout
```

Norn's own options accept its `Duration` type, which also allows ISO 8601 (`'PT15M'`) and compound forms (`'1h30m'`). To use one you receive in workflow input, convert it with `toMs()` from `@norn-ts/norn` (safe in workflow code): `await sleep(toMs(input.remindAfter))`.

## Child workflows

`useChild(ChildWorkflow)` starts other workflows as children, typed from the child class:

```ts
import { Workflow, useChild } from '@norn-ts/norn/workflow';
import { ShipmentWorkflow } from './shipment.workflow';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private readonly shipment = useChild(ShipmentWorkflow);

  async run(input: { orderId: string }) {
    // Starts shipment-{orderId} on the child's own task queue and waits for its result.
    const { trackingNumber } = await this.shipment.execute({ orderId: input.orderId });
    return trackingNumber;
  }
}
```

- `execute(input, options?)` starts the child and resolves with its result.
- `start(input, options?)` resolves once the child is running, with a handle: `workflowId`, `result()` and `signal(method, ...args)`.

The child's ID comes from its `id` template unless you pass `workflowId`. Options, as defaults to `useChild()` or per call: `workflowId`, `parentClosePolicy` (`'terminate'` by default, `'abandon'` or `'request-cancel'`), `taskQueue`, `executionTimeout`, `runTimeout`, `taskTimeout` and `memo`.

To signal or cancel a workflow you didn't start, use `useExternal()`:

```ts
await useExternal(OrderWorkflow, { orderId: input.cancelOrder }).signal('cancel', 'from parent');
```

## Long-running workflows

Each run accumulates an event history, and histories have limits. Long-lived workflows, such as one per customer, periodically **continue as new**: the current run completes and a fresh run with the same ID starts with a new input and an empty history.

```ts
import { condition } from '@temporalio/workflow';
import { Signal, Workflow, continueAsNew, continueAsNewSuggested } from '@norn-ts/norn/workflow';

interface LoyaltyInput {
  customerId: string;
  points?: number;
}

@Workflow({ taskQueue: 'loyalty', id: 'loyalty-{customerId}' })
export class LoyaltyWorkflow {
  private points: number;
  private eventsThisRun = 0;

  constructor(input: LoyaltyInput) {
    this.points = input.points ?? 0; // from the first start, or the previous run
  }

  @Signal() orderCompleted(event: { cents: number }) {
    this.points += Math.floor(event.cents / 100);
    this.eventsThisRun++;
  }

  async run(input: LoyaltyInput): Promise<never> {
    await condition(() => this.eventsThisRun >= 500 || continueAsNewSuggested());
    return continueAsNew<LoyaltyInput>(() => ({ customerId: input.customerId, points: this.points }));
  }
}
```

`continueAsNew()` waits for in-flight handlers first, so pass the input as a function to read it after they finish. It never returns, so `return` it. `continueAsNewSuggested()` is `true` when Temporal recommends rolling over.

## Search attributes

Declare the custom search attributes a workflow sets, then set them with `setSearchAttributes()`:

```ts
@Workflow({
  taskQueue: 'orders',
  id: 'order-{orderId}',
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword', OrderTotal: 'int' },
})
export class OrderWorkflow {
  async run(input: { orderId: string; customerId: string }) {
    setSearchAttributes({ CustomerId: input.customerId, OrderStatus: 'open' });
    // ...
    setSearchAttributes({ OrderStatus: 'paid', OrderTotal: 4_200 }); // null clears one
  }
}
```

Types are `text`, `keyword`, `int`, `double`, `bool`, `datetime` and `keywordList`. Setting an undeclared name, or a value of the wrong type, throws. Custom search attributes must exist on the namespace before workflows use them (`temporal operator search-attribute create`); `createTestEnv()` registers the declared ones for you in tests.

## Failures

When an activity finally fails (non-retryable, or out of retries), the workflow receives an `ActivityFailure` whose `cause` is the activity's error as an `ApplicationFailure`. `asFailure(error, type)` walks the cause chain and returns the matching failure, or `undefined`:

```ts
import { asFailure } from '@norn-ts/norn/workflow';

try {
  await this.payments.charge(input.orderId, input.cents);
} catch (error) {
  const declined = asFailure(error, 'CardDeclinedError'); // or the error class
  if (!declined) throw error; // anything else fails the workflow
  return { status: 'declined', reason: declined.message };
}
```

`isFailure(error, type)` is the boolean form. Matching uses the error's `name`, so give error classes an explicit `name` (`override name = 'CardDeclinedError'`) that survives minification.

Inside workflow code:

- An `ApplicationFailure` thrown from `run()` **fails the workflow**. So does an uncaught activity or child failure.
- An error class listed in `failOn` **fails the workflow** too (or just the update, when thrown from an update handler).
- Any other error **fails the workflow task**, which Temporal retries until you deploy a fix. That's right for bugs and wrong for business outcomes, hence `failOn`.

## Inheritance

Handlers are inherited. A base class can declare signals and queries that several workflows share, and subclasses can override the implementation and keep the registration. Only the concrete class is decorated with `@Workflow`.

```ts
export class Pausable {
  protected paused = false;
  @Signal() pause() {
    this.paused = true;
  }
  @Signal() resume() {
    this.paused = false;
  }
}

@Workflow({ taskQueue: 'jobs' })
export class ImportJobWorkflow extends Pausable {
  async run() {
    await condition(() => !this.paused);
  }
}
```

## Determinism

Workflow code is replayed from history, so it must make the same decisions every time. Inside the sandbox, `Date.now()` returns the time of the current workflow task and `Math.random()` is seeded. You must still avoid I/O, `setTimeout`, `process.env` and `crypto.randomUUID()` (use `uuid4()` from `@temporalio/workflow`), and avoid changing the order of activities and timers that running executions will replay. [Determinism & the sandbox](/norn/concepts/determinism/) explains why.
