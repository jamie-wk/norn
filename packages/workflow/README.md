# @norn/workflow

Write [Temporal](https://temporal.io) workflows as decorated TypeScript classes with [Norn](https://jamie-wk.github.io/norn/). The class's `run()` method is the workflow, its decorated methods are signal, query and update handlers, and its fields are the workflow's state. Activities, child workflows and other workflows are called through typed proxies.

- **`@Workflow`**, **`@Signal`**, **`@Query`**, **`@Update`**, **`@Validate`**, **`@Schedule`**: TC39 standard decorators, checked at compile time (ID templates against `run()`'s input, validators against their update, synchronous queries) and validated again when the class is defined.
- **`useActivities()`**, **`useChild()`**, **`useExternal()`**: typed calls to activities, child workflows and external workflows, without importing activity code into the sandbox.
- **`continueAsNew()`**, **`asFailure()`**, **`setSearchAttributes()`**, **`transitions()`**, **`businessCalendar()`**: helpers for long-running workflows, error handling, visibility and state.

Everything here runs inside Temporal's workflow sandbox: the package depends only on `@norn/core`, `@temporalio/workflow` and `@temporalio/common`, and imports no Node APIs. Keep using `sleep`, `condition`, `patched`, `uuid4` and friends from `@temporalio/workflow` directly; Norn does not wrap them.

## Install

```sh
pnpm add @norn/workflow @temporalio/workflow @temporalio/common
```

Requires Node 22.18+ and TypeScript with **TC39 standard decorators** (`target` ES2022 or later). Do not enable `experimentalDecorators`: legacy decorators have a different signature and will not work. You also want `@norn/cli` (`norn gen` writes the activity references, contracts and workflow barrel used below) and `@norn/worker` to run the workflows.

## Example

```ts
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, asFailure, setSearchAttributes, transitions, useActivities, useChild } from '@norn/workflow';
import { InventoryActivities, PaymentActivities } from '../../.norn/activities.js'; // generated, workflow-safe
import { InvalidItemError, PaymentDeclinedError, type LineItem, type OrderInput } from '../domain.js';
import { ShipmentWorkflow } from './shipment.workflow.js';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}', searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' } })
export class OrderWorkflow {
  private readonly payments = useActivities(PaymentActivities);
  private readonly inventory = useActivities(InventoryActivities);
  private readonly shipment = useChild(ShipmentWorkflow);
  private readonly status = transitions(
    { open: ['charging', 'canceled'], charging: ['paid', 'payment_failed'], paid: [], payment_failed: [], canceled: [] },
    'open',
  );
  private readonly items: LineItem[];
  private submitted = false;
  private cancelReason: string | undefined;

  constructor(input: OrderInput) {
    this.items = [...(input.items ?? [])]; // ready before any handler runs
  }

  @Query() view() {
    return { status: this.status.current, items: this.items.map((i) => ({ ...i })) };
  }

  @Validate('addItem') checkItem(item: LineItem) {
    if (this.submitted) throw new InvalidItemError('Order is already submitted');
    if (!Number.isInteger(item.qty) || item.qty < 1) throw new InvalidItemError('qty must be a positive whole number');
  }

  /** Adds an item and returns the new item count. */
  @Update() addItem(item: LineItem) {
    this.items.push(item);
    return this.items.length;
  }

  @Update() submit() {
    this.submitted = true;
  }

  @Signal() cancel(reason: string) {
    this.cancelReason ??= reason;
  }

  async run(input: OrderInput) {
    setSearchAttributes({ CustomerId: input.customerId, OrderStatus: 'open' });
    if (!(await condition(() => this.submitted || this.cancelReason !== undefined, '7 days'))) return this.view();
    if (this.cancelReason !== undefined) {
      this.status.move('canceled');
      return this.view();
    }
    this.status.move('charging');
    const { totalCents } = await this.inventory.reserve(input.orderId, this.items);
    try {
      await this.payments.charge(input.orderId, totalCents, input.card);
    } catch (error) {
      if (!asFailure(error, PaymentDeclinedError)) throw error;
      await this.inventory.release(input.orderId);
      this.status.move('payment_failed');
      return this.view();
    }
    this.status.move('paid');
    setSearchAttributes({ OrderStatus: 'paid' });
    await this.shipment.execute({ orderId: input.orderId });
    return this.view();
  }
}
```

The workflow imports `PaymentActivities` from the generated **`.norn/activities.ts`**, never from the activity file: that reference holds names and options, with the activity class imported as a type only, so the workflow bundle never contains activity code. `norn gen` also writes `.norn/workflows.ts`, which wraps each class with `implement()` for the worker, and `.norn/contracts.ts` for API code.

### Lifecycle of an execution

For every execution, and on every replay, the workflow function produced by `implement()`:

1. constructs the class with the workflow input (`new OrderWorkflow(input)`), which runs field initializers such as `useActivities()`;
2. registers every signal, query and update handler, before any can be delivered;
3. awaits `run(input)`;
4. waits for in-flight signal and update handlers to finish (`allHandlersFinished`), unless `drainHandlers: false`;
5. returns `run()`'s result.

Handlers can run before the first line of `run()` (update-with-start, or a signal in the first workflow task), so initialize state in the constructor. Constructors must be synchronous and must not schedule activities or timers.

## Decorators

Decorated methods must be public, non-static and string-named. Invalid options throw `NornConfigError` when the class is defined.

### `@Workflow(options)`

```ts
function Workflow<const O extends WorkflowOptions>(options: O): ClassDecorator;
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `taskQueue` | `string` | required | Task queue the workflow runs on. |
| `name` | `string` | class name | Temporal workflow type. Must be a valid identifier, because it is also the export name in the workflow bundle. |
| `id` | `string` | none | Workflow ID template, such as `'order-{orderId}'`. A placeholder that is not a field of `run()`'s input is a compile error. |
| `versioning` | `'pinned' \| 'auto-upgrade'` | worker default | Worker versioning behavior for this workflow type. |
| `searchAttributes` | `Record<string, SearchAttributeType>` | `{}` | Custom search attributes this workflow sets: `'text'`, `'keyword'`, `'int'`, `'double'`, `'bool'`, `'datetime'`, `'keywordList'`. |
| `failOn` | error classes | `[]` | Errors that fail the workflow (or the update they are thrown from) instead of failing and retrying the workflow task. |
| `drainHandlers` | `boolean` | `true` | Wait for in-flight signal and update handlers before completing. |
| `description` | `string` | none | Short description for docs and tooling. |

The class needs a `run()` method. Options must be literals, because `norn gen` reads them from the source.

### `@Signal(options?)`, `@Query(options?)`, `@Update(options?)`

```ts
function Signal<A extends unknown[] = any[]>(options?: string | SignalOptions<A>): MethodDecorator;
function Query(options?: string | HandlerOptions): MethodDecorator;
function Update(options?: string | UpdateOptions): MethodDecorator;

interface HandlerOptions { name?: string; description?: string }
interface SignalOptions<A> extends HandlerOptions {
  unfinishedPolicy?: 'abandon' | 'warn'; // default 'warn'
  dedupeBy?: (...args: A) => string | undefined;
}
interface UpdateOptions extends HandlerOptions { unfinishedPolicy?: 'abandon' | 'warn' }
```

- A string argument is shorthand for `{ name }`. The registered name defaults to the method name; callers always use the method name, and the contract maps it.
- **Queries must be synchronous**: an `async` query method fails to type-check and throws at definition time.
- **`dedupeBy`** returns a key per signal; a signal whose key was already seen in this run is dropped before the handler runs (`undefined` skips deduplication). Keys live in workflow memory for the current run only, so carry recent keys across continue-as-new yourself.
- **`unfinishedPolicy`** applies when a handler is still running as the workflow completes (with `drainHandlers: false`, `continueAsNew(input, { waitForHandlers: false })`, or on failure): `'warn'` logs a warning, `'abandon'` drops it silently.
- JSDoc comments on handler methods become their descriptions in the Temporal UI (`norn gen` passes them to `implement()`); `description` sets one explicitly.

### `@Validate(update)`

```ts
function Validate<const N extends string>(update: N): MethodDecorator;
```

Registers a synchronous validator for the update method `update`. Validators run before the update is accepted; throwing rejects it without writing anything to history, and the caller gets `UpdateRejectedError` (422). Parameters must match the update's (a compile error otherwise). Naming a method that is not an `@Update`, or two validators for one update, throws `NornConfigError` when the workflow is described and is reported by `norn gen`.

### `@Schedule(cron, options?)`

```ts
function Schedule<C extends WorkflowClass>(cron: string | string[], options?: ScheduleOptions<WorkflowInput<C>>): ClassDecorator;
```

Declares a Temporal schedule for the workflow. It only records metadata: `norn gen` writes it to `.norn/schedules.json` and `norn schedules sync` creates, updates and removes the matching schedules. A workflow may have several.

| Option | Default | Description |
| --- | --- | --- |
| `id` | workflow name in kebab case | Schedule ID. |
| `input` | none | Input for every run; type-checked against `run()`'s input. Must be JSON. |
| `overlap` | `'skip'` | `'skip'`, `'buffer-one'`, `'buffer-all'`, `'cancel-other'`, `'terminate-other'` or `'allow-all'`. |
| `timeZone` | UTC | IANA time zone for the cron expressions. |
| `pauseOnFailure` | `false` | Pause the schedule after a failed run. |
| `paused` | `false` | Create the schedule paused. |
| `note` | none | Shown in the Temporal UI. |

```ts
@Workflow({ taskQueue: 'reports' })
@Schedule('0 9 * * 1-5', { id: 'daily-sales-report', timeZone: 'America/Chicago', note: 'Morning sales summary' })
export class DailyReportWorkflow {
  async run() { /* ... */ }
}
```

## Activities: `useActivities(ref, overrides?)`

```ts
function useActivities<R extends ActivitiesRef<any, any>>(ref: R, overrides?: ActivityOverrides<R>): ActivityProxy<R>;
```

Returns one async function per registered activity method, typed from the activity class (`this.payments.charge(orderId, cents, card)` returns `Promise<Awaited<ReturnType<charge>>>`). Methods that are not `@Activity` methods are not on the proxy. Call it as a class field or in the constructor.

The second argument overrides the options declared with `@Activity`: shared options for every method, then per-method options under `methods`. Each option replaces the declared value as a whole (`retry` is replaced, not merged):

```ts
private readonly importer = useActivities(ImportActivities, {
  timeout: '10 minutes',
  heartbeat: '30s',
  methods: { fetchPage: { retries: 2 }, commit: { retries: 0, summary: 'Commit the import' } },
});
```

Options are the `ActivityOptions` from `@norn/core` (`timeout`, `scheduleToClose`, `scheduleToStart`, `heartbeat`, `retries`, `retry`, `local`, `nonRetryable`, `taskQueue`, `summary`); `local: true` schedules a local activity. See `@norn/activity` for what each means.

`defineActivities<T>()({ prefix, methods })` creates the references in `.norn/activities.ts`; you only call it yourself for activities that are not `@Activities` classes. Method keys must be methods of `T`. `activityName(ref, method)` returns the registered name (`'payments.charge'`).

```ts
import type { PaymentActivities as PaymentActivities$ } from '../src/activities/payment.activities.js';

export const PaymentActivities = defineActivities<PaymentActivities$>()({
  prefix: 'payments.',
  methods: { charge: { timeout: '30s', retries: 5, nonRetryable: ['PaymentDeclinedError'] }, refund: { timeout: '30s', retries: 10 } },
});
```

## Child and external workflows

### `useChild(target, defaults?)`

```ts
function useChild<T extends WorkflowClass | AnyWorkflowContract>(target: T, defaults?: ChildOptions): ChildRef<T>;

interface ChildRef<T> {
  start(input, options?: ChildOptions): Promise<ChildHandle<T>>; // resolves once the child is running
  execute(input, options?: ChildOptions): Promise<Output>; // starts and waits for the result
}
interface ChildHandle<T> {
  readonly workflowId: string;
  readonly firstExecutionRunId: string;
  result(): Promise<Output>;
  signal(method, ...args): Promise<void>;
}
```

`target` is a `@Workflow` class from the same bundle, or a contract (`.norn/contracts.ts` or `defineWorkflow()` from `@norn/core`) for a workflow implemented elsewhere. Input, output and signal arguments are typed from it; signals are named by method (class) or contract key. The child's ID comes from its ID template and the input, its task queue from its own declaration.

| `ChildOptions` | Description |
| --- | --- |
| `workflowId` | Explicit ID. Required when the child has no ID template. |
| `parentClosePolicy` | `'terminate'` (default), `'abandon'` or `'request-cancel'`. |
| `taskQueue` | Override the child's task queue. |
| `executionTimeout`, `runTimeout`, `taskTimeout` | `Duration`s. |
| `memo` | Memo for the child execution. |

```ts
private readonly shipment = useChild(ShipmentWorkflow);
const { trackingNumber } = await this.shipment.execute({ orderId: input.orderId });
```

### `useExternal(target, id)`

```ts
function useExternal<T extends WorkflowClass | AnyWorkflowContract>(target: T, id: IdFields | { workflowId: string; runId?: string }): ExternalRef<T>;

interface ExternalRef<T> {
  readonly workflowId: string;
  signal(method, ...args): Promise<void>;
  cancel(): Promise<void>;
}
```

A handle to a workflow this one did not start, by its ID template fields or an explicit ID:

```ts
await useExternal(LoyaltyWorkflow, { customerId: input.customerId }).signal('orderCompleted', { orderId, cents });
await useExternal(OrderWorkflow, { workflowId: 'order-o-42' }).cancel();
```

Workflow code cannot signal-with-start; do that from an activity with `@norn/client`.

## Helpers

### `continueAsNew(input, options?)`

```ts
function continueAsNew<Input>(input: Input | (() => Input), options?: { waitForHandlers?: boolean }): Promise<never>;
function continueAsNewSuggested(): boolean;
```

Continues the workflow as a new run with `input`, after waiting for in-flight signal and update handlers (unless `waitForHandlers: false`), so nothing is lost in the rollover. Pass the input as a function so it is read after those handlers finish; a plain value is captured before they do. `return` it from `run()`. `continueAsNewSuggested()` is `true` when Temporal recommends rolling over because history is getting large.

```ts
async run(input: LoyaltyInput): Promise<never> {
  await condition(() => this.eventsThisRun >= 500 || continueAsNewSuggested());
  return continueAsNew<LoyaltyInput>(() => ({ customerId: input.customerId, points: this.points, recent: this.recent }));
}
```

Read the carried state in the constructor, so handlers see it from the first event of the new run. `transitions()` accepts a `snapshot()` as its initial state for this purpose.

### `asFailure(error, type)` and `isFailure(error, type)`

```ts
function asFailure(error: unknown, type: string | (abstract new (...args: any[]) => Error)): ApplicationFailure | undefined;
function isFailure(error: unknown, type: string | (abstract new (...args: any[]) => Error)): boolean;
```

Walk an error's cause chain (such as `ActivityFailure` → `ApplicationFailure`) and return the `ApplicationFailure` whose type equals the class's `name` (or the string). Norn's activity error mapping records an error's `name` as its failure type, so a workflow can match activity errors without importing activity code:

```ts
try {
  await this.payments.charge(orderId, total, card);
} catch (error) {
  const declined = asFailure(error, PaymentDeclinedError); // or asFailure(error, 'PaymentDeclinedError')
  if (!declined) throw error;
  this.failure = declined.message;
}
```

### `setSearchAttributes(values)`

```ts
function setSearchAttributes(values: Record<string, string | number | boolean | Date | string[] | null>): void;
```

Upserts custom search attributes declared in `@Workflow({ searchAttributes })`, converting them to Temporal's typed search attributes. `null` clears one. A name the workflow does not declare throws `NornConfigError`. Search attributes must exist on the namespace first (`norn gen` lists them in `.norn/search-attributes.json`).

### `transitions()` and `businessCalendar()`

Re-exported from `@norn/core`: a deterministic state machine that ignores illegal moves, and banking-day arithmetic for timers. See the `@norn/core` README.

## Under the hood

`norn gen` writes `export const OrderWorkflow = implement(OrderWorkflow$, { descriptions })` into `.norn/workflows.ts`; Temporal registers workflows by export name, so each export is named after the workflow type.

- `implement(cls, options?)`: returns the workflow function Temporal runs (with a `workflowType` property). It applies `versioning` and `failOn` through `setWorkflowOptions`. `options.descriptions` maps method names to handler descriptions.
- `describeWorkflow(cls)`: the validated `WorkflowDefinition`: name, task queue, ID template, search attributes, handlers with their registered names and validators. Throws `NornConfigError` for duplicate handler names and invalid validators.
- `definitionFor(workflowType)`: the definition registered with `implement()` in this bundle.
- `isWorkflowClass(value)`: whether a class is decorated with `@Workflow`.

Handlers are inherited: a base class can declare signals and queries, and subclasses can override the methods and keep the registrations. Only the concrete class is decorated with `@Workflow`.

## API

| Export | Kind |
| --- | --- |
| `Workflow(options)`, `WorkflowOptions` | Class decorator |
| `Signal(options?)`, `Query(options?)`, `Update(options?)`, `HandlerOptions`, `SignalOptions`, `UpdateOptions`, `UnfinishedPolicy` | Handler decorators |
| `Validate(update)` | Update validator decorator |
| `Schedule(cron, options?)`, `ScheduleOptions`, `ScheduleTag` | Schedule decorator |
| `useActivities(ref, overrides?)`, `ActivityProxy<R>`, `ActivityOverrides<R>` | Activity proxies |
| `defineActivities<T>()(def)`, `activityName(ref, method)`, `ActivitiesRef`, `ActivityMethodKey<T>` | Activity references |
| `useChild(target, defaults?)`, `ChildRef`, `ChildHandle`, `ChildOptions` | Child workflows |
| `useExternal(target, id)`, `ExternalRef` | External workflows |
| `continueAsNew(input, options?)`, `continueAsNewSuggested()`, `ContinueAsNewOptions` | Continue-as-new |
| `asFailure(error, type)`, `isFailure(error, type)` | Failure matching |
| `setSearchAttributes(values)`, `SearchAttributeInput` | Search attributes |
| `implement(cls, options?)`, `definitionFor(workflowType)`, `ImplementOptions`, `WorkflowFunction<C>`, `RunArgs<C>` | Workflow functions (generated code) |
| `describeWorkflow(cls)`, `isWorkflowClass(value)`, `WorkflowDefinition`, `HandlerDefinition`, `VersioningBehavior` | Introspection |
| `transitions`, `businessCalendar`, `Transitions`, `TransitionTable`, `BusinessCalendar`, `ActivityOptions`, `Duration` | Re-exported from `@norn/core` |

## License

MIT
