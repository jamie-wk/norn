# Errors

Errors cross three boundaries in a Temporal application: from an activity to its workflow, from a workflow (or update) to the client, and from the client to your API's HTTP response. Norn makes each crossing predictable: errors are identified by **type name**, client errors have a **stable code and HTTP status**, and nothing depends on matching message strings.

## Norn's error classes

Every client-facing error extends `NornError` from `@norn-ts/core` (re-exported by `@norn-ts/client`), which has a `code`, an HTTP `status`, `details`, and the original SDK error as `cause`. `toJSON()` returns a response-safe `{ code, message, details }` without stack or cause.

| Class | `code` | `status` | When |
| --- | --- | --- | --- |
| `NornConfigError` | `CONFIG` | 500 | Invalid configuration or decorator options, a bad ID template value, a missing provider. Thrown at definition or startup time wherever possible. |
| `WorkflowAlreadyStartedError` | `WORKFLOW_ALREADY_STARTED` | 409 | Starting a workflow whose ID is already running (with `ifRunning: 'fail'`, the default), or reusing a closed ID that `ifClosed` forbids. Has `workflowId`. |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | 404 | The workflow ID (or run) does not exist. Has `workflowId`. |
| `WorkflowClosedError` | `WORKFLOW_CLOSED` | 409 | Signalling, updating, cancelling or terminating a workflow that has already closed. Has `workflowId` and `closeStatus` (`COMPLETED`, `FAILED`, ...). |
| `UpdateRejectedError` | `UPDATE_REJECTED` | 422 | An update's validator threw, or its handler threw an `ApplicationFailure` (or a `failOn` error). Has `workflowId`, `update` and `failureType`. |
| `QueryFailedError` | `QUERY_FAILED` | 500 | A query is not registered, was rejected, or threw. |
| `WorkflowFailedError` | `WORKFLOW_FAILED` | 500 | `result()` or `execute()` on a workflow that failed, was cancelled, terminated or timed out. Has `workflowId` and `failureType`. |
| `TemporalUnavailableError` | `TEMPORAL_UNAVAILABLE` | 503 | The server could not be reached or is rate limiting (gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED` or `RESOURCE_EXHAUSTED`), or a worker could not connect at startup. |

`@norn-ts/hono`'s error handler adds `INTERNAL` (500) for unexpected errors and `WEBHOOK_UNVERIFIED` (401) / `WEBHOOK_INVALID_BODY` (400) for webhooks. `@norn-ts/codec` throws `NornCodecError`, a plain `Error` subclass, for key and payload problems.

You can create your own `NornError`s for domain failures your API returns, and the Hono handler maps them like the built-in ones:

```ts
import { NornError } from '@norn-ts/core';

throw new NornError('INVITATION_EXPIRED', 410, 'This invitation has expired', { details: { invitationId } });
```

`isNornError(value)` is a type guard, and `errorTypeOf(error)` returns the type name Norn records for an error (see below).

## Activity errors

When an activity throws, the container converts the error to a Temporal `ApplicationFailure` before it leaves the worker:

- The failure's **type** is the error's `name` when it is set to something other than `'Error'`, otherwise its class name. Set `override name = 'ClassName'` on your error classes: the name then survives minification, and matches what `asFailure()` looks for.
- Errors listed in `@NonRetryable([...])` (by `instanceof`), or every error under `@NonRetryable()`, become **non-retryable** failures: the activity fails immediately, without retries.
- Everything else is retryable, subject to the activity's retry policy.
- Errors that are already Temporal failures (`ApplicationFailure`, `CancelledFailure`, ...) pass through untouched, so you can still throw `ApplicationFailure.create({ type, nonRetryable, details })` yourself.

```ts
export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

@Activity({ timeout: '30s', retries: 5 })
@NonRetryable([InsufficientFundsError])
async submit(transfer: TransferRequest) {
  const balance = await this.ledger.available(transfer.sourceAccountId);
  if (balance < transfer.amountCents) throw new InsufficientFundsError(`balance ${balance} < ${transfer.amountCents}`);
  // network errors here are retried
  return this.transfers.send(transfer);
}
```

### HTTP status mapping

Most activity failures are HTTP calls. With `errors: { http: true }`, any error carrying an HTTP status (`status`, `statusCode` or `response.status`) between 400 and 499 is final, **except 408 and 429**, which are retried. 5xx and network errors stay retryable:

```ts
const worker = await createWorker({ registry, container: { errors: { http: true } } });
```

That covers fetch wrappers that throw `{ status }` errors, Axios (`response.status`) and most SDK error classes.

### Custom mapping

For anything else, `errors.map(error, activityType)` decides first. Return `'retryable'`, `'non-retryable'`, an `ApplicationFailure` of your own, or `undefined` to fall through to the defaults:

```ts
import { ApplicationFailure } from '@temporalio/common';

const worker = await createWorker({
  registry,
  container: {
    errors: {
      http: true,
      map: (error, activityType) => {
        if (error instanceof StripeCardError) {
          return ApplicationFailure.create({ type: 'CardDeclinedError', message: error.message, nonRetryable: true, details: [{ code: error.code }] });
        }
        if (activityType.startsWith('reports.') && (error as { code?: string }).code === 'ETIMEDOUT') return 'retryable';
        return undefined;
      },
    },
  },
});
```

The order is: Temporal failures pass through, then `@NonRetryable`, then `map`, then `http`, then retryable.

## Handling activity failures in workflows

When an activity finally fails (non-retryable, or out of retries), the workflow receives an `ActivityFailure` whose `cause` is the `ApplicationFailure`. `asFailure(error, ErrorClassOrName)` walks the cause chain and returns the matching `ApplicationFailure`, or `undefined`:

```ts
import { asFailure, isFailure } from '@norn-ts/workflow';
import { PaymentDeclinedError } from '../domain.js';

try {
  const charge = await this.payments.charge(this.orderId, total, input.card);
  this.chargeId = charge.chargeId;
} catch (error) {
  // or asFailure(error, 'PaymentDeclinedError')
  const declined = asFailure(error, PaymentDeclinedError);
  // anything else fails the workflow
  if (!declined) throw error;
  this.failure = declined.message;
  await this.inventory.release(this.orderId);
  return this.finish('payment_failed');
}
```

`isFailure(error, type)` is the boolean form. Matching uses the class's `name` (or the string), so domain error classes can live in a shared, workflow-safe module and be imported by both sides. The workflow never needs to import activity code to recognise an activity's error.

## Workflow errors

Inside workflow code:

- An `ApplicationFailure` thrown from `run()` **fails the workflow**. So does an uncaught activity or child-workflow failure.
- An error class listed in `@Workflow({ failOn: [...] })` **fails the workflow** too (or fails the update, when thrown from an update handler).
- Any other error **fails the workflow task**, which Temporal retries until the code is fixed. The workflow stays open and resumes after you deploy a fix. This is the right behaviour for bugs, and the wrong one for business outcomes, hence `failOn`.

On the client, `result()` throws `WorkflowFailedError` whose `failureType` is the failure's type (`'InvalidOrderError'`) or one of `'Cancelled'`, `'Terminated'` and `'TimedOut'`.

## Client errors

`@norn-ts/client` converts Temporal client errors with `toNornError()`, so API code can branch on classes (or `code`) instead of SDK internals:

```ts
import { UpdateRejectedError, WorkflowAlreadyStartedError, WorkflowClosedError } from '@norn-ts/client';

try {
  await norn.workflow(PaymentWorkflow).get({ paymentId }).update('cancel', { by: userId });
} catch (error) {
  if (error instanceof UpdateRejectedError && error.failureType === 'AlreadySubmittedError') {
    return c.json({ error: 'Too late to cancel: the transfer was already submitted' }, 409);
  }
  if (error instanceof WorkflowClosedError) return c.json({ error: `Payment is ${error.closeStatus.toLowerCase()}` }, 409);
  throw error;
}
```

Signals, updates, cancels and terminates to a workflow that no longer runs come back from the server as "not found". Norn checks whether the workflow exists: if it does and is closed you get `WorkflowClosedError` (409), and only a workflow that never existed gives `WorkflowNotFoundError` (404).

With [`@norn-ts/hono`](/guide/hono), `app.onError(nornErrorHandler())` turns all of these into JSON responses:

```json
{ "error": { "code": "UPDATE_REJECTED", "message": "Too late to cancel", "details": { "workflowId": "payment-p_1", "update": "cancel", "failureType": "AlreadySubmittedError" }, "correlationId": "4f6c..." } }
```
