---
title: "Client"
description: Start, signal, query and update workflows with a client typed from the workflow class, and handle Norn's errors.
---

`createClient()` from `@norn-ts/norn/client` wraps the Temporal client. Give it a `@Workflow` class, and every call is checked against that class: input, result, handler names and arguments, and ID template fields.

```ts
import { createClient } from '@norn-ts/norn/client';
import { OrderWorkflow } from '../workflows/order.workflow';

const norn = createClient();
const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-42', cents: 1999 });
await order.signal('cancel', 'changed my mind');
```

Importing the workflow class into API code is fine: it brings its decorators and the types of its activities (imported with `import type`), never the activity code. The client reads the workflow's name, task queue, ID template and handler names from the decorators.

## `createClient(options?)`

```ts
const norn = createClient({
  // default TEMPORAL_ADDRESS, then localhost:7233
  address: 'my-ns.a1b2c.tmprl.cloud:7233',
  // default TEMPORAL_NAMESPACE, then 'default'
  namespace: 'my-ns.a1b2c',
  // default TEMPORAL_API_KEY; turns TLS on
  apiKey: process.env.TEMPORAL_API_KEY,
});
```

| Option | Description |
| --- | --- |
| `address`, `namespace`, `apiKey` | Connection settings, defaulting to `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY`. An API key, or `TEMPORAL_TLS=true`, turns TLS on. Empty variables count as unset. For mTLS, set `tls`. |
| `tls` | The SDK's TLS options, for mTLS with client certificates (`{ clientCertPair: { crt, key } }`) or a custom CA. |
| `connectTimeout` | A `Duration`. |
| `connection` | An existing `Connection` to use instead of opening one. |
| `client` | An existing Temporal `Client` to wrap (for example a test environment's). Its interceptors are used as they are. |
| `dataConverter` | A custom data converter, matching the worker's (for example one that encrypts payloads). |
| `interceptors` | Client interceptors. |

The connection is **lazy**: creating a client never blocks or fails, and the first call connects. Call `await norn.close()` on shutdown (or use `await using norn = createClient()`); it closes the connection only if Norn opened it. `norn.temporal` is the underlying `Client` and `norn.connection` its connection, for anything Norn doesn't wrap.

Create one client per process and share it.

## Starting workflows

`norn.workflow(WorkflowClass)` returns a `WorkflowClient` for that workflow type:

```ts
const payments = norn.workflow(PaymentWorkflow);

// resolves when started
const handle = await payments.start({ paymentId: 'p_1', amountCents: 50_000 });
// resolves with the result
const result = await payments.execute({ paymentId: 'p_2', amountCents: 10_000 });
```

The workflow ID comes from the class's ID template and the input. Pass `workflowId` to override it, which is required for workflows without a template. A workflow whose `run()` takes no input is started with `start()`.

### Start options

| Option | Description |
| --- | --- |
| `workflowId` | Overrides the ID built from the template. |
| `taskQueue` | Overrides the workflow's task queue. |
| `ifRunning` | When a workflow with this ID is running: `'fail'` (default, throws `WorkflowAlreadyStartedError`, 409), `'useExisting'` (return a handle to it) or `'terminateExisting'`. |
| `ifClosed` | Whether a closed workflow's ID may be reused: `'allow'` (default), `'allowIfFailed'` or `'reject'`. |
| `searchAttributes` | Initial [search attributes](#search-attributes). |
| `memo` | Memo fields. |
| `executionTimeout`, `runTimeout`, `taskTimeout` | Workflow timeouts, as `Duration`s. Most workflows should not set an execution timeout; let timers model deadlines. |
| `startDelay` | Delay the first workflow task, such as `'15 minutes'`. |
| `summary`, `details` | Text shown in the Temporal UI for this execution. |
| `retry` | A workflow retry policy. Rarely needed; retry activities instead. |
| `priority` | The SDK's priority settings. |

`ifRunning` and `ifClosed` together express idempotent starts. "Start this payment unless it's already running or has completed" is the default. "Start a fresh import every time, killing any old one" is `ifRunning: 'terminateExisting'`. "Never run this onboarding twice for the same user" is `ifClosed: 'reject'`.

## Handles

`get()` returns a handle without making a call, from the template's fields or an explicit ID:

```ts
const order = norn.workflow(OrderWorkflow).get({ orderId: 'o-42' });
const sameOrder = norn.workflow(OrderWorkflow).get({ workflowId: 'order-o-42' });
const oldRun = norn.workflow(OrderWorkflow).get({ workflowId: 'order-o-42', runId: '6f1c...' });
```

A handle without a run ID targets the latest run, so it keeps working across continue-as-new.

| Method | Description |
| --- | --- |
| `signal(method, ...args)` | Sends a signal. Resolves when the server accepted it. |
| `query(method, ...args)` | Runs a query and returns its typed result. |
| `update(method, ...args)` | Runs an update and returns its typed result once the handler finishes. Throws `UpdateRejectedError` (422) if it is rejected. |
| `result()` | Waits for the workflow to finish and returns its output. Throws `WorkflowFailedError` on failure. |
| `cancel()` | Requests cancellation. The workflow decides how to clean up. |
| `terminate(reason?)` | Ends the workflow immediately, without cleanup. |
| `describe()` | Returns a `WorkflowSummary`: status, type, task queue, start and close times, history length, typed search attributes and memo. |
| `workflowId`, `runId` | The IDs this handle points at. |
| `temporal` | The underlying SDK handle (`fetchHistory()`, `startUpdate()`, ...). |

Handler names are **method names** from the workflow class; Norn maps them to registered names. Unknown names, wrong argument types and missing arguments are compile errors:

```ts
// ok
await order.signal('cancel', 'why');
// error: expected 2 arguments
await order.signal('cancel');
// error: not a method of OrderWorkflow
await order.signal('checkout');
```

Decorators don't change types, so TypeScript can't tell a signal method from a query method: `order.signal('getStatus')` compiles, and throws a `NornConfigError` when it runs.

## With-start operations

**Signal-with-start** sends a signal, starting the workflow first if it isn't running. It's the standard way to feed events to a [long-running workflow](/norn/guides/workflows/#long-running-workflows) that may not exist yet:

```ts
await norn.workflow(LoyaltyWorkflow).signalWithStart(
  // input, used only if it starts
  { customerId: 'c-7' },
  { signal: 'orderCompleted', args: [{ orderId: 'o-42', cents: 1999 }] },
);
```

**Update-with-start** runs an update, starting the workflow first if needed, and returns the update's result along with the handle. `ifRunning` defaults to `'useExisting'` here:

```ts
const { handle, result } = await norn.workflow(CartWorkflow).updateWithStart(
  { cartId: 'c-9' },
  { update: 'add', args: ['sku-mug'] },
);
// result: { count: 1 }
```

Both take start options as a third argument.

## Listing and counting

`list(query?)` iterates over executions of the workflow type, optionally narrowed by a [visibility query](https://docs.temporal.io/list-filter); `count(query?)` counts them:

```ts
for await (const order of norn.workflow(OrderWorkflow).list(`CustomerId = "c-7" AND ExecutionStatus = "Running"`)) {
  console.log(order.workflowId, order.status, order.searchAttributes.OrderStatus);
}

const stuck = await norn.workflow(PaymentWorkflow).count(`PaymentStatus = "submitted" AND StartTime < "2026-10-01T00:00:00Z"`);
```

The workflow-type filter is added for you. Each item is a `WorkflowSummary`.

## Search attributes

Pass initial values for the search attributes a workflow declares in `@Workflow({ searchAttributes })`:

```ts
await norn.workflow(OrderWorkflow).start({ orderId: 'o-42', customerId: 'c-7' }, { searchAttributes: { CustomerId: 'c-7' } });
```

Values are checked against the declared types when you call (`int` must be an integer, `datetime` a valid `Date`, `keywordList` an array of strings), and undeclared names are rejected. Custom search attributes must exist on the namespace before use: `temporal operator search-attribute create --name CustomerId --type Keyword`.

## Errors

Client calls throw Norn error classes instead of the SDK's, so API code can branch on a class or a stable `code`, and map it to an HTTP status:

| Error | `code` | Status | When |
| --- | --- | --- | --- |
| `WorkflowAlreadyStartedError` | `WORKFLOW_ALREADY_STARTED` | 409 | `start()` with `ifRunning: 'fail'` and the ID is running. |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | 404 | No workflow with that ID exists. |
| `WorkflowClosedError` | `WORKFLOW_CLOSED` | 409 | A signal, update, cancel or terminate to a workflow that has finished. |
| `UpdateRejectedError` | `UPDATE_REJECTED` | 422 | A validator rejected the update, or its handler threw an `ApplicationFailure` or a `failOn` error. `failureType` is the error's name. |
| `QueryFailedError` | `QUERY_FAILED` | 500 | The query handler threw, or the running worker doesn't register that query (for example an older deployment). |
| `WorkflowFailedError` | `WORKFLOW_FAILED` | 500 | `result()` of a failed workflow. `failureType` is the failure's type, or `Cancelled`, `Terminated` or `TimedOut`. |
| `TemporalUnavailableError` | `TEMPORAL_UNAVAILABLE` | 503 | The server can't be reached, or is rate-limiting. |
| `NornConfigError` | `CONFIG` | 500 | Invalid options or input, such as a missing ID template field, or a handler method used as the wrong kind. Thrown before any call to the server. |

```ts
import { UpdateRejectedError, WorkflowClosedError } from '@norn-ts/norn/client';

try {
  await norn.workflow(PaymentWorkflow).get({ paymentId }).update('cancel', { by: userId });
} catch (error) {
  if (error instanceof UpdateRejectedError && error.failureType === 'AlreadySubmittedError') {
    return Response.json({ error: 'Too late to cancel' }, { status: 409 });
  }
  if (error instanceof WorkflowClosedError) return Response.json({ error: `Payment is ${error.closeStatus.toLowerCase()}` }, { status: 409 });
  throw error;
}
```

Every error has `code`, `status`, `message`, `details` and the original SDK error as `cause`. `toJSON()` gives a response-safe shape without the stack or cause.
