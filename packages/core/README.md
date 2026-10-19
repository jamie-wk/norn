# @norn/core

Workflow-safe building blocks shared by every [Norn](https://jamie-wk.github.io/norn/) package: typed workflow contracts, durations, ID templates, the error classes with codes and HTTP statuses, a small state machine, a business-day calendar and the activity option translation.

- **Contracts**: `contract<typeof MyWorkflow>()({...})` (what `norn gen` writes into `.norn/contracts.ts`) and `defineWorkflow({...})` for workflows implemented elsewhere. Clients, child workflows, the fake client and webhooks all take them.
- **Errors**: `NornError` and its subclasses, each with a stable `code`, an HTTP `status`, `details` and the SDK error as `cause`.
- **`Duration`**, **ID templates**, **`transitions()`**, **`businessCalendar()`**: pure, deterministic helpers that are safe inside workflow code.

`@norn/core` has no runtime dependencies and imports no Node APIs, so it runs in the Temporal workflow sandbox, in API servers and on edge runtimes. Most apps get it through `@norn/workflow`, `@norn/client` and the generated files; import it directly for errors, manual contracts and duration helpers.

## Install

```sh
pnpm add @norn/core
```

Requires Node 22.18+ (any modern JavaScript runtime works for the package itself). No peer dependencies.

## Contracts

A contract describes a workflow type for callers: its name, task queue, ID template, handlers and search attributes, with the input, output and handler argument types attached as phantom types. It contains no workflow code.

### Generated contracts

`norn gen` writes one per `@Workflow` class into `.norn/contracts.ts`, importing the class with `import type` so API bundles never contain worker code:

```ts
// .norn/contracts.ts (generated)
import { contract } from '@norn/core';
import type { OrderWorkflow as OrderWorkflow$ } from '../src/workflows/order.workflow.ts';

export const OrderWorkflow = contract<typeof OrderWorkflow$>()({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  id: 'order-{orderId}',
  signals: { cancel: 'cancel', paymentEvent: 'paymentEvent' },
  queries: { view: 'view' },
  updates: { addItem: 'addItem', submit: 'submit' },
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
});
```

Keys are method names (what TypeScript callers use); values are the registered names sent to Temporal. The input type is the first parameter of `run()`, the output its awaited return type, and handler argument and result types come from the methods. Keys that are not methods of the class, and ID template fields that are not fields of `run()`'s input, are compile errors.

### Manual contracts

For a workflow implemented in another service or language, write the contract with `defineWorkflow()`:

```ts
import { defineWorkflow, query, signal, type, update } from '@norn/core';

export const Fulfilment = defineWorkflow({
  name: 'FulfilmentWorkflow',
  taskQueue: 'fulfilment',
  id: 'fulfilment-{orderId}',
  input: type<{ orderId: string; warehouse: string }>(),
  output: type<{ shippedAt: string }>(),
  signals: { hold: signal<[reason: string]>() },
  queries: { stage: query<'picking' | 'packing' | 'shipped'>() },
  updates: { changeAddress: update<{ ok: boolean }, [address: Address]>('change-address') },
  searchAttributes: { Warehouse: 'keyword' },
});
```

- `type<T>()` declares a type with no runtime value.
- `signal<Args>(name?)`, `query<Result, Args>(name?)`, `update<Result, Args>(name?)`: the registered name defaults to the key.
- The ID template is checked against the `input` type at compile time.

Both forms validate at runtime too: a missing name or task queue, a malformed ID template, an unknown search attribute type or two handlers of one kind with the same registered name throw `NornConfigError`.

### Using a contract

```ts
OrderWorkflow.name; // 'OrderWorkflow'
OrderWorkflow.taskQueue; // 'orders'
OrderWorkflow.workflowId({ orderId: 'o-42' }); // 'order-o-42'
```

`workflowId(params)` throws `NornConfigError` when the contract has no ID template or a field is empty. Type helpers read the phantom types: `ContractInput<C>`, `ContractOutput<C>`, `IdParams<C>`, `SearchAttributeValues<C>`, `RefArgs<R>` and `RefResult<R>`.

## Durations

```ts
type Duration = number | `${number}${ShortUnit}` | `${number} ${LongUnit}` | `P${string}` /* plus two-part compounds such as '1h30m' */;
function toMs(duration: Duration): number;
function formatDuration(duration: Duration): `${number}ms`;
```

Every Norn option that takes a time accepts a `Duration`:

- milliseconds as a finite, non-negative number: `30_000`
- a number and a short unit (`ms`, `s`, `m`, `h`, `d`, `w`): `'90s'`, `'15m'`
- a number, a space and a long unit (`second(s)`, `sec(s)`, `minute(s)`, `min(s)`, `hour(s)`, `hr(s)`, `day(s)`, `week(s)`, `millisecond(s)`): `'5 days'`
- compound forms: `'1h30m'`, `'1h 30m'`
- ISO 8601 with weeks, days, hours, minutes and seconds: `'PT15M'`, `'P1DT12H'`

Months and years are rejected because they have no fixed length. `toMs()` returns whole milliseconds and throws `NornConfigError` for anything invalid; `formatDuration()` returns the `'<n>ms'` string the Temporal SDK accepts. Inside workflows, convert a `Duration` from your input before passing it to `sleep()` or `condition()`: `await sleep(toMs(input.remindAfter))`.

## ID templates

```ts
function templateKeys(template: string): string[];
function formatWorkflowId(template: string, input: unknown): string;
type TemplateKeys<T extends string>; // 'orderId' for 'order-{orderId}'
type MissingTemplateKeys<T extends string, Input>; // never when every placeholder is a field of Input
```

`'invoice-{companyId}-{invoiceNumber}'` has two placeholders. Placeholder names must be identifiers and braces must balance. When formatting, each value must be a non-empty string, a number or a bigint; anything else throws `NornConfigError` before the call reaches Temporal.

## Errors

```ts
class NornError extends Error {
  constructor(code: string, status: number, message: string, options?: { cause?: unknown; details?: Record<string, unknown> });
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  toJSON(): { code: string; message: string; details: Record<string, unknown> }; // no stack, no cause
}
```

| Class | `code` | `status` | Extra fields |
| --- | --- | --- | --- |
| `NornConfigError` | `CONFIG` | 500 | Invalid options, decorator use or ID template values. Thrown at definition or startup time wherever possible |
| `WorkflowAlreadyStartedError` | `WORKFLOW_ALREADY_STARTED` | 409 | `workflowId` |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | 404 | `workflowId` |
| `WorkflowClosedError` | `WORKFLOW_CLOSED` | 409 | `workflowId`, `closeStatus` |
| `UpdateRejectedError` | `UPDATE_REJECTED` | 422 | `workflowId`, `update`, `failureType` |
| `QueryFailedError` | `QUERY_FAILED` | 500 | `details.workflowId`, `details.query` |
| `WorkflowFailedError` | `WORKFLOW_FAILED` | 500 | `workflowId`, `failureType` |
| `TemporalUnavailableError` | `TEMPORAL_UNAVAILABLE` | 503 | |

The subclasses take a single arguments object, for example `new UpdateRejectedError({ workflowId, update, failureType, message, cause? })` or `new WorkflowClosedError({ workflowId, closeStatus })`, which is handy for stubbing in tests. Throw your own `NornError` for domain failures that your API returns:

```ts
import { NornError } from '@norn/core';

throw new NornError('INVITATION_EXPIRED', 410, 'This invitation has expired', { details: { invitationId } });
```

- `isNornError(value)`: type guard.
- `errorTypeOf(error)`: the failure type Norn records for an error: its `name` if set to something other than `'Error'`, otherwise its class name. Activities and `asFailure()` in workflows use the same rule. Set `override name = 'ClassName'` on your error classes so the name survives minification.

## `transitions(table, initial)`

A deterministic state machine for workflow status. Illegal or repeated moves are ignored instead of corrupting state, which suits out-of-order and duplicate events such as webhooks.

```ts
import { transitions } from '@norn/core'; // also re-exported by @norn/workflow

const status = transitions(
  {
    open: ['charging', 'canceled'],
    charging: ['paid', 'payment_failed'],
    paid: [],
    payment_failed: [],
    canceled: [],
  },
  'open',
);

status.move('paid'); // false: not a legal move from 'open'
status.move('charging'); // true
status.is('charging', 'paid'); // true
```

```ts
interface Transitions<S extends string> {
  readonly current: S;
  readonly version: number; // incremented by every applied move
  readonly isTerminal: boolean; // no outgoing moves
  can(next: S): boolean;
  move(next: S): boolean; // applies a legal move, returns whether it did
  is(...states: S[]): boolean;
  snapshot(): TransitionSnapshot<S>; // { current, version }, to carry across continue-as-new
}
```

Every target in the table must be a state (checked at compile time and at runtime), and `initial` is a state name or a snapshot from a previous run.

## `businessCalendar(options?)`

Banking-day arithmetic for timers such as ACH settlement windows. Pure, so it is safe in workflow code; load holidays with an activity and pass them in.

```ts
import { businessCalendar } from '@norn/core'; // also re-exported by @norn/workflow

const calendar = businessCalendar({ holidays: ['2026-12-25'], utcOffsetMinutes: -300 });
await condition(() => this.settled, calendar.msUntilBusinessDays(Date.now(), 3));
```

| Option | Default | Description |
| --- | --- | --- |
| `holidays` | `[]` | Non-business dates as `YYYY-MM-DD`, in the calendar's time zone. |
| `weekend` | `[0, 6]` | Weekend days, `0` = Sunday ... `6` = Saturday. |
| `utcOffsetMinutes` | `0` | Fixed offset from UTC used to decide calendar days. |

The calendar has `isBusinessDay(at)`, `addBusinessDays(from, days)` (keeps the time of day; `0` rolls forward to a business day) and `msUntilBusinessDays(from, days)`. Dates are `number` (epoch ms) or `Date`.

## Activity options

`ActivityOptions` is the shape of `@Activity()` options (see `@norn/activity`). `toActivityOptions(options)` turns them into Temporal SDK options: `timeout` → `startToCloseTimeout` (default `DEFAULT_ACTIVITY_TIMEOUT`, 60 000 ms, when neither `timeout` nor `scheduleToClose` is set), `retries: n` → `retry.maximumAttempts: n + 1`, `nonRetryable` → `retry.nonRetryableErrorTypes`, and options that don't apply to local activities are dropped. It throws `NornConfigError` for invalid durations, a zero `timeout`, `scheduleToClose` or retry interval, a `backoffCoefficient` below 1, non-integer counts, `retry.maximumAttempts` below 1, or `retries` combined with `retry.maximumAttempts`. `@norn/workflow`'s `useActivities()` calls it for you.

## Decorator metadata

The workflow sandbox freezes `Symbol`, so Norn cannot use `Symbol.metadata`. Decorators instead tag the decorated functions and classes with registered symbols (`NORN.workflow`, `NORN.handler`, `NORN.activity`, ...), which also lets separate copies of the packages agree. `tagMethod`, `readMethodTag`, `setClassTag`, `classTag` and `methodTags` read and write those tags; they are public for tooling and are not needed in application code.

## API

| Export | Kind |
| --- | --- |
| `contract<C>()(def)` | Contract typed from a workflow class (generated by `norn gen`) |
| `defineWorkflow(def)`, `type<T>()`, `signal<Args>(name?)`, `query<Result, Args>(name?)`, `update<Result, Args>(name?)` | Manual contracts |
| `isWorkflowContract(value)` | Type guard |
| `WorkflowContract`, `AnyWorkflowContract`, `ContractInput<C>`, `ContractOutput<C>`, `IdParams<C>`, `IdParamsFor<Input, Id>`, `SearchAttributeValues<C>` | Contract types |
| `SignalRef`, `QueryRef`, `UpdateRef`, `HandlerRef`, `RefArgs<R>`, `RefResult<R>` | Handler reference types |
| `ManualWorkflowDef`, `ManualContract<D>`, `TypeSpec`, `SignalSpec`, `QuerySpec`, `UpdateSpec` | Manual contract types |
| `WorkflowClass`, `WorkflowInput<C>`, `WorkflowOutput<C>`, `HandlerMethodKey<C>`, `GeneratedWorkflowDef<C>`, `GeneratedContract<C, D>` | Generated contract types |
| `SearchAttributeType`, `SearchAttributeTypes`, `SearchAttributeValue<T>`, `SEARCH_ATTRIBUTE_TYPES` | `'text' \| 'keyword' \| 'int' \| 'double' \| 'bool' \| 'datetime' \| 'keywordList'` |
| `Duration`, `toMs(duration)`, `formatDuration(duration)` | Durations |
| `templateKeys(template)`, `formatWorkflowId(template, input)`, `TemplateKeys<T>`, `MissingTemplateKeys<T, Input>` | ID templates |
| `NornError`, `NornConfigError`, `WorkflowAlreadyStartedError`, `WorkflowNotFoundError`, `WorkflowClosedError`, `UpdateRejectedError`, `QueryFailedError`, `WorkflowFailedError`, `TemporalUnavailableError`, `NornErrorOptions` | Errors |
| `isNornError(value)`, `errorTypeOf(error)` | Error helpers |
| `transitions(table, initial)`, `Transitions`, `TransitionTable`, `TransitionSnapshot` | State machine |
| `businessCalendar(options?)`, `BusinessCalendar`, `BusinessCalendarOptions` | Business days |
| `ActivityOptions`, `RetryOptions`, `TemporalActivityOptions`, `toActivityOptions(options)`, `DEFAULT_ACTIVITY_TIMEOUT` | Activity options |
| `NORN`, `tagMethod`, `readMethodTag`, `setClassTag`, `classTag`, `methodTags`, `MethodTag` | Decorator metadata |
| `CORRELATION_HEADER` | `'norn-correlation-id'`, the Temporal header that carries correlation IDs |

## License

MIT
