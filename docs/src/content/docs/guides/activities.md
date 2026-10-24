---
title: "Activities"
---

Activities are where side effects happen: HTTP calls, database writes, emails, payments. In Norn an activity is a method on a class decorated with `@Activities`; the class gets its dependencies through its constructor, and workflows call its methods through a typed, workflow-safe proxy.

```ts
// src/activities/notification.activities.ts
import { Activities, Activity, NonRetryable, idempotencyKey } from '@norn-ts/activity';
import { Mailer, InvalidAddressError } from '../services/mailer.js';

@Activities({ prefix: 'notify.' })
export class NotificationActivities {
  constructor(private readonly mailer: Mailer) {}

  @Activity({ timeout: '20s', retries: 8 })
  @NonRetryable([InvalidAddressError])
  async email(to: string, template: string, data: Record<string, unknown>) {
    return this.mailer.send({ to, template, data, idempotencyKey: idempotencyKey() });
  }
}
```

```ts
// in a workflow
import { NotificationActivities } from '../../.norn/activities.js';

export class OrderWorkflow {
  private readonly notify = useActivities(NotificationActivities);

  async run(input: OrderInput) {
    await this.notify.email(input.email, 'order_paid', { orderId: input.orderId });
  }
}
```

## `@Activities` and `@Activity`

`@Activities(options)` marks the class. Every `@Activity` method is registered with the worker under `prefix + name`:

| `@Activities` option | Description |
| --- | --- |
| `prefix` | Prefix for every activity name in the class, such as `'payments.'`. Default none. Prefixes keep names unique across classes, and two classes registering the same name is an error. |
| `inject` | Explicit constructor dependencies, in parameter order. Normally inferred by `norn gen`; see [Dependency injection](/norn/guides/dependency-injection/#explicit-inject). |

`@Activity(options)` registers a method. Its options are recorded in the generated reference, so workflows schedule the activity with exactly these settings:

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Registered name without the prefix. Default: the method name. |
| `timeout` | `Duration` | **Start-to-close**: how long a single attempt may run. Default **1 minute** when neither `timeout` nor `scheduleToClose` is set. Must be greater than zero. |
| `scheduleToClose` | `Duration` | Total time allowed across all attempts, including retries and backoff. Must be greater than zero. |
| `scheduleToStart` | `Duration` | How long the task may wait in the queue before a worker picks it up. |
| `heartbeat` | `Duration` | Heartbeat timeout. An attempt that doesn't heartbeat this often is considered lost and retried. |
| `retries` | `number` | **Retries after the first attempt.** `0` means a single attempt; `3` means up to four attempts. |
| `retry` | `RetryOptions` | Full retry policy: `initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts` (attempts *including* the first). |
| `local` | `boolean` | Run as a [local activity](#local-activities). |
| `nonRetryable` | `string[]` | Error type names that are never retried. Usually filled in from `@NonRetryable`. |
| `taskQueue` | `string` | Run on a different task queue than the calling workflow. |
| `summary` | `string` | Short summary shown in the Temporal UI. |

`Duration` values are milliseconds or strings like `'30s'`, `'5 minutes'`, `'1h30m'` or `'PT2M'` (months and years are rejected, since they have no fixed length). Options are validated when the class is defined: a bad duration, a `backoffCoefficient` below 1 or a non-integer `retries` throws a `NornConfigError` at startup, not mid-workflow.

### Retries: `retries` vs `retry`

Temporal's default retry policy retries **forever**, with exponential backoff from 1 second up to 100 seconds. That is often what you want for flaky dependencies, but it means a broken activity keeps retrying until someone notices. `retries` is the simple, explicit knob:

```ts
// up to 6 attempts, default backoff
@Activity({ timeout: '30s', retries: 5 })
// tuned backoff
@Activity({ timeout: '30s', retries: 5, retry: { initialInterval: '200ms', maximumInterval: '5s' } })
// the same count, Temporal-style
@Activity({ timeout: '30s', retry: { maximumAttempts: 6, backoffCoefficient: 3 } })
```

Use either `retries` or `retry.maximumAttempts`, not both; the combination is rejected. Without either, retries are unlimited and bounded only by `scheduleToClose`, if you set it.

### `@NonRetryable`

Some errors will never succeed on retry: a declined card, an invalid address, a 404. `@NonRetryable([ErrorClass, ...])` makes those errors fail the activity immediately; `@NonRetryable()` with no argument makes every error final. It goes on a method or on the class (applying to every method):

```ts
@Activities({ prefix: 'inventory.' })
// for every method in the class
@NonRetryable([OutOfStockError])
export class InventoryActivities {
  @Activity({ timeout: '5s', local: true })
  async reserve(skus: string[]) { /* ... */ }

  @Activity()
  // nothing in release() is worth retrying
  @NonRetryable()
  async release(skus: string[]) { /* ... */ }
}
```

A method-level `@NonRetryable` replaces the class-level list for that method. Matching is by `instanceof` on the worker, and the error class names are recorded in the generated reference so the workflow-side retry policy agrees. See [Errors](/norn/guides/errors/#activity-errors) for how thrown errors become failures, the HTTP status mapping, and custom mapping.

## Calling activities from workflows: `useActivities()`

`useActivities(ref)` returns an object with one async function per registered method, typed from the activity class:

```ts
private readonly pay = useActivities(PaymentActivities);
// this.pay.charge: (orderId: string, cents: number) => Promise<Charge>
```

Call it as a class field (or in the constructor). The reference comes from `.norn/activities.ts`, never from the activity file itself.

### Per-call-site overrides

The second argument overrides options for this proxy, on top of what the activity declares: shared options for every method, and per-method options under `methods`:

```ts
// A batch import can wait longer and should give up sooner than the defaults.
private readonly importer = useActivities(ImportActivities, {
  timeout: '10 minutes',
  heartbeat: '30s',
  methods: {
    fetchPage: { retries: 2 },
    commit: { retries: 0, summary: 'Commit the import' },
  },
});
```

Precedence is: the activity's own options, then the shared overrides, then the per-method overrides. Each option replaces the declared value as a whole; `retry` in particular is replaced, not merged, so pass the complete policy you want. Overriding the attempt count with either `retries` or `retry.maximumAttempts` replaces the declared count, whichever form it used.

## Local activities

`local: true` runs the activity in the same worker process as the workflow, without a round trip through the task queue. It is faster and cheaper, which suits short, idempotent operations such as reading a price list or reserving stock in a local database. The trade-offs: no heartbeats, no separate task queue, no `scheduleToStart`, and long local activities hold up the workflow task. Keep them under a few seconds. Norn drops the options that don't apply to local activities.

## Context helpers

Inside an activity (and inside services it calls), `@norn-ts/activity` exports helpers for the running activity:

```ts
import { activityInfo, cancellationSignal, heartbeat, idempotencyKey, lastHeartbeat } from '@norn-ts/activity';
```

| Helper | Description |
| --- | --- |
| `activityInfo()` | The SDK's `Info`: activity ID and type, attempt number, task queue, workflow execution. |
| `idempotencyKey(suffix?)` | A key that is **stable across retries** of one scheduled activity: `workflowId/runId/activityId`, plus the suffix. Pass it to APIs that support idempotency keys. |
| `heartbeat(details?)` | Records progress. Required more often than the `heartbeat` timeout for long-running activities; also how an activity learns it was cancelled. |
| `lastHeartbeat()` | The details of the last heartbeat from a previous attempt, so a retry can resume where it left off. |
| `cancellationSignal()` | An `AbortSignal` that fires when the activity is cancelled. Pass it to `fetch()` and other cancellable calls. |
| `getCorrelationId()` | The correlation ID the workflow carried, if any. See [Observability](/norn/guides/observability/). |

All of them throw a `NornConfigError` when called outside a running activity, so a service used both inside and outside activities should guard the call.

:::tip[Idempotency keys for money]
`idempotencyKey()` is unique per scheduled activity. If the *workflow* can schedule the same logical operation twice (say, a retry loop in workflow code, or a reset), prefer a business key such as `charge-${paymentId}`, which is stable across workflow runs too.
:::

### A resumable, heartbeating activity

```ts
@Activity({ timeout: '2 hours', heartbeat: '30s', retries: 5 })
async importRows(fileId: string) {
  // resume after a crash or retry
  let offset = lastHeartbeat<number>() ?? 0;
  const signal = cancellationSignal();
  for await (const batch of this.files.read(fileId, { offset, signal })) {
    await this.db.insert(batch);
    offset += batch.length;
    heartbeat(offset);
  }
  return offset;
}
```

## Activities that call Temporal

An activity may start or signal other workflows; inject a Norn client through a provider:

```ts
// src/providers.ts
export const TemporalClient = token<NornClient>('TemporalClient');
export const providers = [provide(TemporalClient, () => createClient(), { dispose: (client) => client.close() })];

// src/activities/loyalty.activities.ts
@Activities({ prefix: 'loyalty.', inject: [TemporalClient] })
export class LoyaltyActivities {
  constructor(private readonly client: NornClient) {}

  @Activity({ timeout: '20s', retries: 10 })
  async credit(customerId: string, orderId: string, cents: number) {
    await this.client.workflow(LoyaltyWorkflow).signalWithStart({ customerId }, { signal: 'orderCompleted', args: [{ orderId, cents }] });
  }
}
```

`inject` is needed here because the parameter type (`NornClient`) is not a token itself. Because the activity runs with the workflow's correlation ID, the client call carries it onward.

## Activity-only workers

To run some activities on their own task queue (for example, GPU work or a rate-limited partner API), set `taskQueue` on the activity and run a worker for that queue with `allowUnknownTaskQueues: true`. See [Worker & deployment](/norn/guides/worker/#choosing-task-queues).
