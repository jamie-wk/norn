---
title: "@norn-ts/core"
description: Contracts, durations, ID templates, error classes, transitions() and businessCalendar(), shared by every Norn package.
sidebar:
  order: 2
---

Workflow-safe building blocks shared by every Norn package: typed workflow contracts, durations, ID templates, the error classes with codes and HTTP statuses, a small state machine, a business-day calendar and the activity option translation.

- **Contracts**: `contract<typeof MyWorkflow>()({...})` (what `norn gen` writes into `.norn/contracts.ts`) and `defineWorkflow({...})` for workflows implemented elsewhere. Clients, child workflows, the fake client and webhooks all take them.
- **Errors**: `NornError` and its subclasses, each with a stable `code`, an HTTP `status`, `details` and the SDK error as `cause`.
- **`Duration`**, **ID templates**, **`transitions()`**, **`businessCalendar()`**: pure, deterministic helpers that are safe inside workflow code.

`@norn-ts/core` has no runtime dependencies and imports no Node APIs, so it runs in the Temporal workflow sandbox, in API servers and on edge runtimes. Most apps get it through [`@norn-ts/workflow`](/norn/reference/workflow/), [`@norn-ts/client`](/norn/reference/client/) and the generated files. Import it directly for errors, manual contracts and duration helpers.

## Install

```sh
pnpm add @norn-ts/core
```

Requires Node 22.18+ (any modern JavaScript runtime works for the package itself). No peer dependencies.

## Contracts

A contract describes a workflow type for callers: its name, task queue, ID template, handlers and search attributes, with the input, output and handler argument types attached as phantom types. It contains no workflow code. [Contracts & the client/worker split](/norn/concepts/contracts/) explains why they exist.

### Generated contracts

`norn gen` writes one per `@Workflow` class into `.norn/contracts.ts`. It imports the class with `import type`, so API bundles never contain worker code:

```ts
// .norn/contracts.ts (generated)
import { contract } from '@norn-ts/core';
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

Keys are method names (what TypeScript callers use). Values are the registered names sent to Temporal. The input type is the first parameter of `run()`, the output is its awaited return type, and handler argument and result types come from the methods. Keys that are not methods of the class, and ID template fields that are not fields of `run()`'s input, are compile errors.

### Manual contracts

For a workflow implemented in another service or language, write the contract with `defineWorkflow()`:

```ts
import { defineWorkflow, query, signal, type, update } from '@norn-ts/core';

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

| Helper | Description |
| --- | --- |
| `type<T>()` | Declares a type with no runtime value. |
| `signal<Args>(name?)` | A signal. `Args` defaults to `[]`. |
| `query<Result, Args>(name?)` | A query. `Args` defaults to `[]`. |
| `update<Result, Args>(name?)` | An update. `Args` defaults to `[]`. |

The registered name of a handler defaults to its key. The ID template is checked against the `input` type at compile time.

Both forms also validate at runtime. These throw `NornConfigError`: a missing name or task queue, a malformed ID template, an unknown search attribute type, an empty handler name, or two handlers of one kind with the same registered name.

### Using a contract

```ts
// 'OrderWorkflow'
OrderWorkflow.name;
// 'orders'
OrderWorkflow.taskQueue;
// 'order-o-42'
OrderWorkflow.workflowId({ orderId: 'o-42' });
```

A contract is a frozen object with these properties:

| Property | Description |
| --- | --- |
| `kind` | Always `'norn.workflow'`. `isWorkflowContract(value)` checks it. |
| `name` | The workflow type name. |
| `taskQueue` | The task queue. |
| `idTemplate` | The ID template, or `undefined`. |
| `signals`, `queries`, `updates` | Handler references by method name: `{ kind, name }`. |
| `searchAttributes` | Search attribute names and types. |
| `workflowId(params)` | Builds the workflow ID from the template. Throws `NornConfigError` when the contract has no ID template or a field is empty. |

Type helpers read the phantom types: `ContractInput<C>`, `ContractOutput<C>`, `IdParams<C>`, `SearchAttributeValues<C>`, `RefArgs<R>` and `RefResult<R>`.

### Search attribute types

| Norn type | Temporal type | TypeScript value |
| --- | --- | --- |
| `'text'` | `TEXT` | `string` |
| `'keyword'` | `KEYWORD` | `string` |
| `'int'` | `INT` | `number` |
| `'double'` | `DOUBLE` | `number` |
| `'bool'` | `BOOL` | `boolean` |
| `'datetime'` | `DATETIME` | `Date` |
| `'keywordList'` | `KEYWORD_LIST` | `string[]` |

`SEARCH_ATTRIBUTE_TYPES` lists the Norn names. `TEMPORAL_SEARCH_ATTRIBUTE_TYPES` maps each to Temporal's name, as `defineSearchAttributeKey()` takes it. `isSearchAttributeValue(type, value)` is the value check the client and `setSearchAttributes()` share: numbers must be finite, and dates valid.

## Durations

```ts
type Duration = number | `${number}${ShortUnit}` | `${number} ${LongUnit}` | `P${string}`;
function toMs(duration: Duration): number;
function formatDuration(duration: Duration): `${number}ms`;
```

The `Duration` type also includes two-part compounds such as `'1h30m'` and `'1h 30m'`. Every Norn option that takes a time accepts a `Duration`:

| Form | Examples |
| --- | --- |
| Milliseconds as a finite, non-negative number | `30_000` |
| A number and a short unit: `ms`, `s`, `m`, `h`, `d`, `w` | `'90s'`, `'15m'` |
| A number, a space and a long unit: `ms`, `millisecond(s)`, `sec(s)`, `second(s)`, `min(s)`, `minute(s)`, `hr(s)`, `hour(s)`, `day(s)`, `week(s)` | `'5 days'` |
| Compound forms | `'1h30m'`, `'1h 30m'` |
| ISO 8601 with weeks, days, hours, minutes and seconds | `'PT15M'`, `'P1DT12H'` |

Months and years are rejected because they have no fixed length. Units are case-insensitive and decimals are allowed (`'1.5h'`). `toMs()` returns whole milliseconds (rounded) and throws `NornConfigError` for anything invalid. `formatDuration()` returns the `'<n>ms'` string the Temporal SDK accepts.

Inside workflows, convert a `Duration` from your input before passing it to `sleep()` or `condition()`:

```ts
await sleep(toMs(input.remindAfter));
```

## ID templates

```ts
function templateKeys(template: string): string[];
function formatWorkflowId(template: string, input: unknown): string;
// 'orderId' for 'order-{orderId}'
type TemplateKeys<T extends string>;
// never when every placeholder is a field of Input
type MissingTemplateKeys<T extends string, Input>;
```

`'invoice-{companyId}-{invoiceNumber}'` has two placeholders. Placeholder names must be identifiers (the `IDENTIFIER` pattern) and braces must balance. A template with no placeholders is returned as is. When formatting, `input` must be an object, and each value must be a non-empty string, a number or a bigint. Anything else throws `NornConfigError` before the call reaches Temporal.

## Errors

```ts
class NornError extends Error {
  constructor(code: string, status: number, message: string, options?: { cause?: unknown; details?: Record<string, unknown> });
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  // no stack, no cause
  toJSON(): { code: string; message: string; details: Record<string, unknown> };
}
```

`name` is set to the class name. `details` defaults to `{}`.

| Class | `code` | `status` | Fields | `details` |
| --- | --- | --- | --- | --- |
| `NornConfigError` | `CONFIG` | 500 | | Invalid options, decorator use or ID template values. Thrown at definition or startup time wherever possible. |
| `WorkflowAlreadyStartedError` | `WORKFLOW_ALREADY_STARTED` | 409 | `workflowId` | `workflowId`, `workflowType` (when known) |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | 404 | `workflowId` | `workflowId`, `runId` (when known) |
| `WorkflowClosedError` | `WORKFLOW_CLOSED` | 409 | `workflowId`, `closeStatus` | `workflowId`, `closeStatus` |
| `UpdateRejectedError` | `UPDATE_REJECTED` | 422 | `workflowId`, `update`, `failureType` | the same |
| `QueryFailedError` | `QUERY_FAILED` | 500 | | `workflowId`, `query` |
| `WorkflowFailedError` | `WORKFLOW_FAILED` | 500 | `workflowId`, `failureType` | the same |
| `TemporalUnavailableError` | `TEMPORAL_UNAVAILABLE` | 503 | | |

`NornConfigError` takes `(message, options?)`. The other subclasses take a single arguments object, which is handy for stubbing in tests:

```ts
new UpdateRejectedError({ workflowId, update, failureType, message, cause });
new WorkflowClosedError({ workflowId, closeStatus });
new WorkflowAlreadyStartedError({ workflowId, workflowType });
new WorkflowNotFoundError({ workflowId, runId });
new QueryFailedError({ workflowId, query, message });
new WorkflowFailedError({ workflowId, failureType, message });
new TemporalUnavailableError({ message });
```

Throw your own `NornError` for domain failures that your API returns:

```ts
import { NornError } from '@norn-ts/core';

throw new NornError('INVITATION_EXPIRED', 410, 'This invitation has expired', { details: { invitationId } });
```

| Helper | Description |
| --- | --- |
| `isNornError(value)` | Type guard. |
| `errorTypeOf(error)` | The failure type Norn records for an error: its `name` if set to something other than `'Error'`, otherwise its class name (`'Error'` for non-errors). Activities and `asFailure()` in workflows use the same rule. |

:::tip
Set `override name = 'ClassName'` on your error classes so the name survives minification.
:::

See [Errors](/norn/guides/errors/) for how errors cross the activity, workflow and client boundaries.

## `transitions(table, initial)`

A deterministic state machine for workflow status. Illegal or repeated moves are ignored instead of corrupting state, which suits out-of-order and duplicate events such as webhooks.

```ts
// also re-exported by @norn-ts/workflow
import { transitions } from '@norn-ts/core';

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

// false: not a legal move from 'open'
status.move('paid');
// true
status.move('charging');
// true
status.is('charging', 'paid');
```

```ts
interface Transitions<S extends string> {
  readonly current: S;
  // incremented by every applied move
  readonly version: number;
  // no outgoing moves
  readonly isTerminal: boolean;
  can(next: S): boolean;
  // applies a legal move, returns whether it did
  move(next: S): boolean;
  is(...states: S[]): boolean;
  // { current, version }, to carry across continue-as-new
  snapshot(): TransitionSnapshot<S>;
}
```

Every target in the table must be a state, and `initial` is a state name or a snapshot from a previous run. Both are checked at compile time and at runtime (`NornConfigError`). Moving to the current state is not a legal move. `version` is handy with `condition(() => status.version > before)`.

## `businessCalendar(options?)`

Banking-day arithmetic for timers such as ACH settlement windows. Pure, so it is safe in workflow code. Load holidays with an activity and pass them in.

```ts
// also re-exported by @norn-ts/workflow
import { businessCalendar } from '@norn-ts/core';

const calendar = businessCalendar({ holidays: ['2026-12-25'], utcOffsetMinutes: -300 });
await condition(() => this.settled, calendar.msUntilBusinessDays(Date.now(), 3));
```

| Option | Default | Description |
| --- | --- | --- |
| `holidays` | `[]` | Non-business dates as `YYYY-MM-DD`, in the calendar's time zone. |
| `weekend` | `[0, 6]` | Weekend days, `0` = Sunday ... `6` = Saturday. |
| `utcOffsetMinutes` | `0` | Fixed offset from UTC, in minutes, used to decide calendar days. |

| Method | Description |
| --- | --- |
| `isBusinessDay(at)` | Whether `at` falls on a business day. |
| `addBusinessDays(from, days)` | Epoch ms `days` business days after `from`, keeping the time of day. `0` rolls forward to a business day. |
| `msUntilBusinessDays(from, days)` | Milliseconds from `from` until that point; pass it to `sleep()` or `condition()`. |

Dates are `number` (epoch ms) or `Date`. `businessCalendar()` throws `NornConfigError` for a holiday that is not a real `YYYY-MM-DD` date, a weekend with seven days or values outside 0–6, or a non-finite offset. `days` must be a non-negative integer.

## Activity options

`ActivityOptions` is the shape of `@Activity()` options (see [`@norn-ts/activity`](/norn/reference/activity/)). `toActivityOptions(options)` turns them into Temporal SDK options (`TemporalActivityOptions`). [`useActivities()`](/norn/reference/workflow/) calls it for you.

| Norn option | Temporal option |
| --- | --- |
| `timeout` | `startToCloseTimeout`. Defaults to `DEFAULT_ACTIVITY_TIMEOUT` (60 000 ms) when neither `timeout` nor `scheduleToClose` is set. |
| `scheduleToClose` | `scheduleToCloseTimeout` |
| `scheduleToStart` | `scheduleToStartTimeout` (dropped for local activities) |
| `heartbeat` | `heartbeatTimeout` (dropped for local activities) |
| `taskQueue` | `taskQueue` (dropped for local activities) |
| `summary` | `summary` |
| `retries: n` | `retry.maximumAttempts: n + 1` |
| `retry` | `retry` (`initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts`) |
| `nonRetryable` | `retry.nonRetryableErrorTypes` |

It throws `NornConfigError` for invalid durations, a zero `timeout`, `scheduleToClose` or retry interval, a `backoffCoefficient` below 1, non-integer counts, `retry.maximumAttempts` below 1, or `retries` combined with `retry.maximumAttempts`.

## Decorator metadata

The workflow sandbox freezes `Symbol`, so Norn cannot use `Symbol.metadata`. Decorators instead tag the decorated functions and classes with registered symbols (`NORN.workflow`, `NORN.handler`, `NORN.validator`, `NORN.activities`, `NORN.activity`, `NORN.nonRetryable`, `NORN.service`), which also lets separate copies of the packages agree. `tagMethod`, `readMethodTag`, `setClassTag`, `classTag` and `methodTags` read and write those tags. They are public for tooling and are not needed in application code.

## Exports

| Export | Kind |
| --- | --- |
| `contract<C>()(def)` | Contract typed from a workflow class (generated by `norn gen`) |
| `defineWorkflow(def)`, `type<T>()`, `signal<Args>(name?)`, `query<Result, Args>(name?)`, `update<Result, Args>(name?)` | Manual contracts |
| `isWorkflowContract(value)` | Type guard |
| `WorkflowContract`, `AnyWorkflowContract`, `ContractInput<C>`, `ContractOutput<C>`, `IdParams<C>`, `IdParamsFor<Input, Id>`, `SearchAttributeValues<C>` | Contract types |
| `SignalRef`, `QueryRef`, `UpdateRef`, `HandlerRef`, `RefArgs<R>`, `RefResult<R>` | Handler reference types |
| `ManualWorkflowDef`, `ManualContract<D>`, `TypeSpec`, `SignalSpec`, `QuerySpec`, `UpdateSpec` | Manual contract types |
| `WorkflowClass`, `WorkflowInput<C>`, `WorkflowOutput<C>`, `HandlerMethodKey<C>`, `GeneratedWorkflowDef<C>`, `GeneratedContract<C, D>` | Generated contract types |
| `SearchAttributeType`, `SearchAttributeTypes`, `SearchAttributeValue<T>`, `SEARCH_ATTRIBUTE_TYPES`, `TEMPORAL_SEARCH_ATTRIBUTE_TYPES`, `isSearchAttributeValue(type, value)` | Search attribute types |
| `Duration`, `toMs(duration)`, `formatDuration(duration)` | Durations |
| `templateKeys(template)`, `formatWorkflowId(template, input)`, `TemplateKeys<T>`, `MissingTemplateKeys<T, Input>`, `IDENTIFIER` | ID templates. `IDENTIFIER` is the name rule for template keys and workflow, handler and activity names. |
| `ScheduleOverlap`, `SCHEDULE_OVERLAPS` | `@Schedule`'s `overlap` values: `'skip' \| 'buffer-one' \| 'buffer-all' \| 'cancel-other' \| 'terminate-other' \| 'allow-all'` |
| `NornError`, `NornConfigError`, `WorkflowAlreadyStartedError`, `WorkflowNotFoundError`, `WorkflowClosedError`, `UpdateRejectedError`, `QueryFailedError`, `WorkflowFailedError`, `TemporalUnavailableError`, `NornErrorOptions` | Errors |
| `NORN_ERROR_STATUS`, `NornCoreErrorCode` | Each core error code and its HTTP status, such as `WORKFLOW_NOT_FOUND: 404` |
| `isNornError(value)`, `errorTypeOf(error)` | Error helpers |
| `transitions(table, initial)`, `Transitions`, `TransitionTable`, `TransitionSnapshot` | State machine |
| `businessCalendar(options?)`, `BusinessCalendar`, `BusinessCalendarOptions` | Business days |
| `ActivityOptions`, `RetryOptions`, `TemporalActivityOptions`, `toActivityOptions(options)`, `DEFAULT_ACTIVITY_TIMEOUT`, `activityName(ref, method)` | Activity options. `activityName()` is the registered type name: `prefix + (name ?? method)`. |
| `connectionSettings(env, overrides?)`, `ConnectionSettings`, `ConnectionOverrides` | Temporal connection settings from options and `TEMPORAL_*` variables (empty counts as unset), as the client, worker and CLI resolve them. Certificate files are paths; reading them is left to the caller. |
| `NORN`, `tagMethod`, `readMethodTag`, `setClassTag`, `classTag`, `methodTags`, `MethodTag` | Decorator metadata |
| `CORRELATION_HEADER` | `'norn-correlation-id'`, the Temporal header that carries correlation IDs |
