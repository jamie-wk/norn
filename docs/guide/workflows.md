# Workflows

A Norn workflow is a class decorated with `@Workflow`. Its `run()` method is the workflow's main line; its decorated methods handle [signals, queries and updates](/guide/messages); its fields are the workflow's state.

```ts
import { sleep } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn-ts/workflow';
import { ReminderActivities } from '../../.norn/activities.js';

export interface ReminderInput {
  userId: string;
  email: string;
}

@Workflow({ taskQueue: 'reminders', id: 'reminder-{userId}' })
export class ReminderWorkflow {
  private snoozed = 0;
  private readonly notify = useActivities(ReminderActivities);

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

## Lifecycle of an execution

For every execution (and on every replay), the generated workflow function does exactly this:

1. **Constructs the class with the workflow input**: `new ReminderWorkflow(input)`. Field initialisers run here too, including `useActivities()` proxies.
2. **Registers every signal, query and update handler**, before any of them can be delivered.
3. **Calls `run(input)`** and awaits it.
4. **Waits for in-flight handlers to finish** (unless `drainHandlers: false`), so an async signal or update handler that is still awaiting an activity is not cut off.
5. Returns `run()`'s result as the workflow result.

The constructor matters because handlers can run before `run()` gets anywhere. With update-with-start, or a signal that arrives in the first workflow task, a handler may run before the first line of `run()`. Doing initialisation in the constructor means handlers always see initialised state:

```ts
@Workflow({ taskQueue: 'carts', id: 'cart-{cartId}' })
export class CartWorkflow {
  private readonly items: string[];

  constructor(input: { cartId: string; seed?: string[] }) {
    // ready before the first update runs
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

Constructors must be synchronous and must not schedule activities or timers; they only set up state. The constructor parameter and `run()`'s parameter are the same value; declare the type on both (the contract's input type comes from `run()`).

## `@Workflow` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `taskQueue` | `string` | required | Task queue the workflow runs on. Workers poll it; clients start it there. |
| `name` | `string` | class name | Temporal workflow type. Must be a valid identifier, because it is also the export name in the workflow bundle. |
| `id` | `string` | none | Workflow ID template, such as `'order-{orderId}'`. Placeholders are fields of `run()`'s input. |
| `versioning` | `'pinned'` or `'auto-upgrade'` | worker default | Worker-versioning behavior for this workflow type. See [Versioning](/guide/versioning). |
| `searchAttributes` | `Record<string, SearchAttributeType>` | `{}` | Custom search attributes the workflow sets, with their types. |
| `failOn` | error classes | `[]` | Errors that fail the workflow (or the update) instead of retrying the workflow task. |
| `drainHandlers` | `boolean` | `true` | Wait for in-flight signal and update handlers before completing. |

All options must be literals, because [`norn gen`](/guide/project-layout#how-norn-gen-works) reads them from source.

### ID templates

An `id` template turns business keys into workflow IDs, so callers never build ID strings by hand and the same order can never run twice by accident:

```ts
@Workflow({ taskQueue: 'payments', id: 'payment-{paymentId}' })
export class PaymentWorkflow {
  async run(input: { paymentId: string; amountCents: number }) { /* ... */ }
}

// Client side:
// ID "payment-p_123"
await norn.workflow(PaymentWorkflow).start({ paymentId: 'p_123', amountCents: 5_000 });
// same ID, no string building
norn.workflow(PaymentWorkflow).get({ paymentId: 'p_123' });
```

Templates are **checked at compile time**. If a placeholder is not a field of `run()`'s input, the decorator itself fails to type-check:

```ts
// error: ID template field "orderId" is not a field of run()'s input
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class BadIdWorkflow {
  async run(input: { id: string }) {}
}
```

At runtime, placeholder values must be non-empty strings, numbers or bigints; anything else throws a `NornConfigError` before the call reaches Temporal. Templates may use several fields (`'invoice-{companyId}-{invoiceNumber}'`). Without a template, callers pass `{ workflowId }` explicitly.

### `failOn`: failing instead of retrying

In Temporal, an exception thrown from workflow code is treated as a bug: the workflow *task* fails and is retried until you deploy a fix, while the workflow stays open. That is the right default for a `TypeError`. For errors that represent a business outcome, list them in `failOn` and the **workflow execution** fails instead (and an update handler that throws one fails just that update):

```ts
export class InvalidOrderError extends Error {
  override name = 'InvalidOrderError';
}

@Workflow({ taskQueue: 'orders', failOn: [InvalidOrderError] })
export class StrictOrderWorkflow {
  async run(input: { cents: number }) {
    // fails the workflow
    if (input.cents <= 0) throw new InvalidOrderError('cents must be positive');
    // ...
  }
}
```

Throwing an `ApplicationFailure` from `@temporalio/common` always fails the workflow, with or without `failOn`. Activity failures that you don't catch fail the workflow too. See [Errors](/guide/errors).

### `drainHandlers`

By default the workflow does not complete while a signal or update handler is still running; it waits for `allHandlersFinished()` after `run()` returns. This prevents a classic bug where an async handler is awaiting an activity, `run()` returns, and the handler's work is silently abandoned. The workflow's result is still the value `run()` returned, captured before the wait, so handlers that finish during it don't change it. If the result should include their effects, `await condition(allHandlersFinished)` yourself before building it. Set `drainHandlers: false` only if you deliberately want to complete immediately; pair it with `unfinishedPolicy` on the handlers (see [Messages](/guide/messages#unfinished-handlers)).

## Writing deterministic code

Workflow code is replayed from history, so it must make the same decisions every time it runs. The sandbox helps: inside a workflow, `Date.now()` and `new Date()` return the time of the current workflow task, and `Math.random()` is seeded per execution. You must still avoid:

- I/O of any kind: network, files, databases. Do it in an [activity](/guide/activities).
- `setTimeout` and friends: use `sleep()` or `condition()` from `@temporalio/workflow`.
- `process.env`: pass configuration in the input, or read it in an activity.
- `crypto.randomUUID()`: use `uuid4()` from `@temporalio/workflow`.
- `Temporal.Now` (the TC39 Temporal API reads the real clock): derive times from `Date.now()`.
- Changing the order of commands (activities, timers, child workflows) in code that running executions will replay. Use `patched()` or worker versioning; see [Versioning & safe deploys](/guide/versioning).

`norn gen` and the [ESLint plugin](/guide/eslint) report the common mistakes.

### Timers and waiting

Use the SDK's primitives directly; Norn doesn't wrap them:

```ts
import { condition, sleep } from '@temporalio/workflow';

// a durable timer: survives worker restarts and deploys
await sleep('3 days');
// true if approved, false on timeout
const approved = await condition(() => this.approved, '48 hours');
// wait with no timeout
await condition(() => this.items.length > 0);
```

`sleep()` and `condition()` take milliseconds or the SDK's duration strings (`'90s'`, `'2 hours'`, `'3 days'`). Norn's own options accept the [`Duration`](https://github.com/jamie-wk/norn/tree/main/packages/core#durations) type, which also allows ISO 8601 (`'PT15M'`) and compound forms (`'1h30m'`); when you receive a Norn `Duration` in workflow input, convert it with `toMs()` from `@norn-ts/core`:

```ts
import { toMs, type Duration } from '@norn-ts/core';

async run(input: { remindAfter: Duration }) {
  await sleep(toMs(input.remindAfter));
}
```

## Search attributes

Declare the custom search attributes a workflow sets, then set them with `setSearchAttributes()`:

```ts
import { Workflow, setSearchAttributes } from '@norn-ts/workflow';

@Workflow({
  taskQueue: 'orders',
  id: 'order-{orderId}',
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword', OrderTotal: 'int' },
})
export class OrderWorkflow {
  async run(input: { orderId: string; customerId: string }) {
    setSearchAttributes({ CustomerId: input.customerId, OrderStatus: 'open' });
    // ...
    setSearchAttributes({ OrderStatus: 'paid', OrderTotal: 4_200 });
    // setSearchAttributes({ OrderTotal: null }) clears one
  }
}
```

Types are `text`, `keyword`, `int`, `double`, `bool`, `datetime` and `keywordList`. Setting a name the workflow doesn't declare, or a value of the wrong type, throws, so mistakes fail loudly. The declared attributes are also in the workflow's contract, so clients get typed `searchAttributes` on start and in `describe()` results, and can filter with `list()`. Custom search attributes must exist on the namespace before workflows use them; `norn gen` writes them all to `.norn/search-attributes.json` (see [Client: search attributes](/guide/client#search-attributes)).

## Reusing handlers with inheritance

Handlers are inherited. A base class can declare signals and queries that several workflows share; subclasses can override the implementation and keep the registration:

```ts
export class Pausable {
  protected paused = false;
  @Signal() pause() {
    this.paused = true;
  }
  @Signal() resume() {
    this.paused = false;
  }
  @Query() isPaused() {
    return this.paused;
  }
}

@Workflow({ taskQueue: 'jobs' })
export class ImportJobWorkflow extends Pausable {
  override resume() {
    // still the 'resume' signal
    super.resume();
  }
  async run() {
    await condition(() => !this.paused);
    // ...
  }
}
```

Only the concrete workflow class is decorated with `@Workflow`.

## State machines with `transitions()`

Real workflows react to events that arrive late, twice or out of order (webhooks, user clicks, retries). `transitions()` from `@norn-ts/workflow` is a tiny deterministic state machine that ignores illegal moves instead of corrupting state:

```ts
import { transitions } from '@norn-ts/workflow';

private readonly status = transitions(
  {
    pending: ['submitted', 'canceled'],
    submitted: ['settled', 'failed'],
    settled: ['returned'],
    failed: [],
    canceled: [],
    returned: [],
  },
  'pending',
);

@Signal() settled() {
  // returns false (and does nothing) unless the current state is 'submitted'
  this.status.move('settled');
}
```

The machine has `current`, `version` (incremented on every applied move, handy for `condition(() => s.version > before)`), `isTerminal`, `can(next)`, `move(next)`, `is(...states)` and `snapshot()` (to carry across [continue-as-new](/guide/long-running)). The table is type-checked: every target must be a state.

## Business-day timers

`businessCalendar()` does deterministic banking-day arithmetic for timers such as ACH settlement windows:

```ts
import { businessCalendar } from '@norn-ts/workflow';

const calendar = businessCalendar({ holidays: input.holidays, utcOffsetMinutes: -300 });
await condition(() => this.settled, calendar.msUntilBusinessDays(Date.now(), 3));
```

It is pure arithmetic, so it is safe in workflow code; load the holiday list with an activity and pass it in (or fetch it once at the start of the workflow).

## Under the hood

`norn gen` writes `export const OrderWorkflow = implement(OrderWorkflow)` into `.norn/workflows.ts`. You rarely call these yourself, but they are public:

- `implement(cls, { descriptions })` returns the Temporal workflow function, with `workflowType` set.
- `describeWorkflow(cls)` returns the validated definition: name, task queue, handlers, validators and options.
- `isWorkflowClass(value)` checks for the `@Workflow` decorator.

Decorated methods must be public, non-static and string-named; `@Workflow` validates its options when the class is defined and throws `NornConfigError` for bad values. See the [`@norn-ts/workflow` README](https://github.com/jamie-wk/norn/tree/main/packages/workflow#readme).
