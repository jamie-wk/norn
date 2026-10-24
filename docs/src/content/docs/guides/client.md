---
title: "Client"
---

`@norn-ts/client` is a typed wrapper around the Temporal client. You give it a contract (from `.norn/contracts.ts`), and every call is checked against the workflow class: inputs, outputs, handler names and arguments, search attributes, ID template fields.

```ts
import { createClient } from '@norn-ts/client';
import { OrderWorkflow } from '../.norn/contracts.js';

const norn = createClient();

const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-42', cents: 1999 });
await order.update('addItem', { sku: 'sku-mug', qty: 1 });
await order.signal('cancel', 'customer request');
const view = await order.query('view');
const final = await order.result();
```

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
| `address`, `namespace`, `apiKey` | Connection settings, defaulting to `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY`. An API key, or `TEMPORAL_TLS=true`, turns TLS on. Empty variables count as unset. For mTLS client certificates pass your own `connection`. |
| `tls` | The SDK's TLS options, for mTLS with client certificates (`{ clientCertPair: { crt, key } }`) or a custom CA. |
| `connectTimeout` | A `Duration`. |
| `connection` | An existing `Connection` to use instead of opening one. |
| `client` | An existing Temporal `Client` to wrap (for example a test environment's). Its interceptors are used as they are. |
| `dataConverter` | For encrypted payloads, `clientDataConverter()` from [`@norn-ts/codec`](/norn/guides/encryption/). |
| `interceptors` | Extra client interceptors, after Norn's correlation interceptor. |
| `correlation` | Add the [correlation ID](/norn/guides/observability/#correlation-ids) header to outbound calls. Default `true`. |

The connection is **lazy**: creating a client never blocks or fails, and the first call connects. Call `await norn.close()` on shutdown (or use `await using norn = createClient()`); it closes the connection only if Norn opened it. `norn.temporal` is the underlying `Client` and `norn.connection` its connection, for anything Norn doesn't wrap.

Create one client per process and share it. With Hono, the [`temporal()` middleware](/norn/guides/hono/) does that for you.

## Starting workflows

`norn.workflow(Contract)` returns a `WorkflowClient` for that workflow type:

```ts
const payments = norn.workflow(PaymentWorkflow);

// resolves when started
const handle = await payments.start({ paymentId: 'p_1', amountCents: 50_000 });
// resolves with the result
const result = await payments.execute({ paymentId: 'p_2', amountCents: 10_000 });
```

The workflow ID comes from the contract's ID template and the input. Pass `workflowId` to override it, which is required for workflows without a template. A workflow whose `run()` takes no input is started with `start()`.

### Start options

| Option | Description |
| --- | --- |
| `workflowId` | Overrides the ID built from the template. |
| `taskQueue` | Overrides the contract's task queue. |
| `ifRunning` | When a workflow with this ID is running: `'fail'` (default, throws `WorkflowAlreadyStartedError`, 409), `'useExisting'` (return a handle to it) or `'terminateExisting'`. |
| `ifClosed` | Whether a closed workflow's ID may be reused: `'allow'` (default), `'allowIfFailed'` or `'reject'`. |
| `searchAttributes` | Initial [search attributes](#search-attributes), typed from the contract. |
| `memo` | Memo fields. |
| `executionTimeout`, `runTimeout`, `taskTimeout` | Workflow timeouts, as `Duration`s. Most workflows should not set an execution timeout; let timers model deadlines. |
| `startDelay` | Delay the first workflow task, such as `'15 minutes'`. |
| `summary`, `details` | Text shown in the Temporal UI for this execution. |
| `retry` | A workflow retry policy. Rarely needed; retry activities instead. |
| `priority` | The SDK's priority settings. |
| `correlationId` | The correlation ID for this call; defaults to the current one. |

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

Handler names are **method names** from the workflow class; the contract maps them to registered names. Misspelled names, wrong argument types and missing arguments are compile errors:

```ts
// ok
await order.signal('cancel', 'why');
// error: expected 2 arguments
await order.signal('cancel');
// error: not a signal of OrderWorkflow
await order.signal('checkout');
```

## With-start operations

**Signal-with-start** sends a signal, starting the workflow first if it isn't running. It is the standard way to feed events to an [entity workflow](/norn/guides/long-running/#patterns-for-long-running-workflows) that may not exist yet:

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

`list(query?)` iterates over executions of the contract's workflow type, optionally narrowed by a [visibility query](https://docs.temporal.io/list-filter); `count(query?)` counts them:

```ts
for await (const order of norn.workflow(OrderWorkflow).list(`CustomerId = "c-7" AND ExecutionStatus = "Running"`)) {
  console.log(order.workflowId, order.status, order.searchAttributes.OrderStatus);
}

const stuck = await norn.workflow(PaymentWorkflow).count(`PaymentStatus = "submitted" AND StartTime < "2026-10-01T00:00:00Z"`);
```

The workflow-type filter is added for you. Each item is a `WorkflowSummary` with typed search attributes.

## Search attributes

Search attributes declared in `@Workflow({ searchAttributes })` are part of the contract, so start options and summaries are typed:

```ts
await norn.workflow(OrderWorkflow).start(
  { orderId: 'o-42', customerId: 'c-7' },
  // CustomerId: string; an undeclared name or a number is a compile error
  { searchAttributes: { CustomerId: 'c-7' } },
);
```

Values are also checked at runtime against the declared type (`int` must be an integer, `datetime` a valid `Date`, `keywordList` an array of strings).

Custom search attributes must be registered on the namespace before use. `norn gen` writes all of them to `.norn/search-attributes.json`; register them once per namespace, for example:

```sh
temporal operator search-attribute create --name CustomerId --type Keyword
temporal operator search-attribute create --name OrderStatus --type Keyword
```

On Temporal Cloud, add them in the namespace settings or with `tcld`. In tests, `createTestEnv()` registers the registry's search attributes on the dev server automatically.

## Correlation IDs

Every call made inside `runWithCorrelationId(id, fn)` carries `id` in a header; workers pass it to activities, children and continue-as-new runs, so one ID ties an HTTP request to every activity it causes:

```ts
import { getCorrelationId, runWithCorrelationId } from '@norn-ts/client';

await runWithCorrelationId(req.headers['x-request-id'] ?? crypto.randomUUID(), async () => {
  await norn.workflow(OrderWorkflow).start(input);
});
// or per call:
await norn.workflow(OrderWorkflow).start(input, { correlationId: 'req-123' });
```

The Hono middleware does this for every request. See [Observability](/norn/guides/observability/#correlation-ids).

## Manual contracts

For a workflow that isn't defined in this codebase (implemented by another team, in another service, or in another language), write the contract by hand with `defineWorkflow()` from `@norn-ts/core`:

```ts
import { defineWorkflow, query, signal, type, update } from '@norn-ts/core';

export const Fulfilment = defineWorkflow({
  // the workflow type the other side registers
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

`type<T>()` declares a type with no runtime value; `signal`, `query` and `update` take an optional registered name (defaulting to the key). The ID template is checked against the input type. Manual contracts work everywhere generated ones do: the client, `useChild()`, `useExternal()`, the fake client and webhooks.

## Errors

Client calls throw the [Norn error classes](/norn/guides/errors/#norns-error-classes): `WorkflowAlreadyStartedError` (409), `WorkflowNotFoundError` (404), `WorkflowClosedError` (409), `UpdateRejectedError` (422), `QueryFailedError` (500), `WorkflowFailedError` (500) and `TemporalUnavailableError` (503). They are re-exported from `@norn-ts/client`.
