---
title: "Activities"
description: Plain activity classes, how workflows call them with useActivities(), timeouts and retries, non-retryable errors, heartbeats and local activities.
---

Activities are where side effects happen: HTTP calls, database writes, emails, payments. In Norn an activity class is a plain class. It gets its dependencies through its constructor like any other class, and workflows call its methods through a typed proxy.

```ts
// src/activities/notify.activities.ts
import type { Mailer } from '../services/mailer';

export class NotifyActivities {
  constructor(private readonly mailer: Mailer) {}

  async email(to: string, template: string) {
    return this.mailer.send({ to, template });
  }
}
```

```ts
// src/workflows/order.workflow.ts
import type { NotifyActivities } from '../activities/notify.activities';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private readonly notify = useActivities<NotifyActivities>('notify', { timeout: '20s', retries: 8 });

  async run(input: OrderInput) {
    await this.notify.email(input.email, 'order_paid');
  }
}
```

```ts
// src/worker.ts
await createWorker({
  workflows: new URL('./workflows/index.ts', import.meta.url),
  activities: { notify: new NotifyActivities(new SmtpMailer(process.env.SMTP_URL)) },
});
```

Three things tie these together:

- **The namespace.** The worker registers every method of `activities.notify` as `notify.<method>`, such as `notify.email`. `useActivities<NotifyActivities>('notify')` schedules the same names.
- **The type.** The workflow imports the class with `import type`, so it gets the method signatures and no activity code reaches the workflow sandbox. Calls return promises of the method's result.
- **The options.** Timeouts and retries are set where the workflow calls the activity, as in the Temporal SDK.

Activity arguments and results go through Temporal's data converter, so they must be JSON-serializable by default.

## `useActivities()` options

The second argument sets options for every method, and `methods` overrides them per method:

```ts
private readonly payments = useActivities<PaymentActivities>('payments', {
  timeout: '30s',
  retries: 3,
  nonRetryable: ['CardDeclinedError'],
  methods: {
    refund: { retries: 10 },
    audit: { local: true, timeout: '2s' },
  },
});
```

| Option | Type | Description |
| --- | --- | --- |
| `timeout` | `Duration` | **Start-to-close**: how long a single attempt may run. Default **1 minute** when neither `timeout` nor `scheduleToClose` is set. |
| `scheduleToClose` | `Duration` | Total time allowed across all attempts, including retries and backoff. |
| `scheduleToStart` | `Duration` | How long the task may wait in the queue before a worker picks it up. |
| `heartbeat` | `Duration` | Heartbeat timeout. An attempt that doesn't heartbeat this often is considered lost and retried. |
| `retries` | `number` | **Retries after the first attempt.** `0` means a single attempt; `3` means up to four. |
| `retry` | `RetryOptions` | Full retry policy: `initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts` (attempts *including* the first). |
| `nonRetryable` | `string[]` | Error names that are never retried. |
| `local` | `boolean` | Run as a [local activity](#local-activities). |
| `taskQueue` | `string` | Run on a different task queue than the calling workflow. |
| `summary` | `string` | Short summary shown in the Temporal UI. |

`Duration` values are milliseconds or strings like `'30s'`, `'5 minutes'`, `'1h30m'` or `'PT2M'`. A bad duration, a `backoffCoefficient` below 1, or `retries` together with `retry.maximumAttempts`, throws a `NornConfigError` the first time the method is used.

A method that isn't on the class is a compile error, both as a call (`this.payments.nope()`) and as a key in `methods`.

## Errors and retries

Temporal's default retry policy retries **forever**, with exponential backoff from 1 second up to 100 seconds. That's often right for flaky dependencies, but a broken activity then retries until someone notices. `retries` is the simple, explicit knob:

```ts
useActivities<Acts>('acts', { timeout: '30s', retries: 5 }); // up to 6 attempts
useActivities<Acts>('acts', { timeout: '30s', retries: 5, retry: { initialInterval: '200ms', maximumInterval: '5s' } });
```

Some errors never succeed on retry: a declined card, an invalid address, a 404. List their names in `nonRetryable`, and give the error classes an explicit `name`, because Temporal records an error's `name` as its failure type and minifiers rename classes:

```ts
export class CardDeclinedError extends Error {
  override name = 'CardDeclinedError';
}
```

You can also decide in the activity itself by throwing `ApplicationFailure.nonRetryable(message, type)` from `@temporalio/common`. In the workflow, [`asFailure()`](/norn/guides/workflows/#failures) recognizes the error by name once retries are exhausted.

Activities run **at least once**: an attempt can succeed and then time out before the result is recorded, so it's retried. Make activities idempotent, for example by passing the order ID as the payment provider's idempotency key.

## Heartbeats and cancellation

Long-running activities should heartbeat, so Temporal notices a lost worker quickly and the activity can be cancelled. Use the SDK's activity API directly:

```ts
import { heartbeat, Context } from '@temporalio/activity';

export class ImportActivities {
  async importRows(fileId: string, startAt = 0) {
    const resume = Context.current().info.heartbeatDetails ?? startAt;
    for (let row = resume; row < total; row++) {
      await importRow(fileId, row);
      heartbeat(row); // details are available to the next attempt
    }
  }
}
```

Pair it with a `heartbeat` timeout in `useActivities()`. `Context.current().cancellationSignal` is an `AbortSignal` you can pass to `fetch()`.

## Local activities

`local: true` runs an activity in the same worker as the workflow, without a round trip through the task queue. It's for short, fast calls such as a cache lookup or a cheap validation. Local activities can't heartbeat, and `scheduleToStart`, `heartbeat` and `taskQueue` are ignored for them.

## Testing activities

An activity class is a plain class, so unit-test it with a fake dependency, no Temporal needed:

```ts
const mailer = { send: vi.fn(async () => 'msg-1') };
expect(await new NotifyActivities(mailer).email('a@b.c', 'welcome')).toBe('msg-1');
```

To test a workflow without real activities, pass fakes to the [test environment](/norn/guides/testing/).
