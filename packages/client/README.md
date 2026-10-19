# @norn/client

A typed Temporal client for [Norn](https://jamie-wk.github.io/norn/). Give it a contract (from `.norn/contracts.ts`, or `defineWorkflow()` from `@norn/core`) and every call is checked at compile time against the workflow: input and output, ID template fields, signal, query and update names and arguments, and search attributes. Temporal errors come back as Norn errors with stable codes and HTTP statuses.

- **`createClient()`**: a lazy connection configured from options or `TEMPORAL_*` environment variables, with correlation IDs on every outbound call.
- **`norn.workflow(Contract)`**: `start`, `execute`, `get`, `signalWithStart`, `updateWithStart`, `list` and `count`; handles with `signal`, `query`, `update`, `result`, `cancel`, `terminate` and `describe`.
- **Errors**: `WorkflowAlreadyStartedError` (409), `WorkflowNotFoundError` (404), `WorkflowClosedError` (409), `UpdateRejectedError` (422), `QueryFailedError` (500), `WorkflowFailedError` (500), `TemporalUnavailableError` (503).

API code never imports worker code: generated contracts import workflow classes with `import type`.

## Install

```sh
pnpm add @norn/client @temporalio/client @temporalio/common
```

Requires Node 22.18+ (the Temporal client uses gRPC; Bun and Deno work with Node compatibility).

## Usage

```ts
import { createClient } from '@norn/client';
import { OrderWorkflow } from './.norn/contracts.js';

// TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
await using norn = createClient();

const orders = norn.workflow(OrderWorkflow);
const order = await orders.start({ orderId: 'o-42', customerId: 'c-7', email: 'a@example.com', card: 'tok', items: [] }, {
  searchAttributes: { CustomerId: 'c-7' },
// workflow ID 'order-o-42', from the contract's template
});

// returns addItem()'s result
await order.update('addItem', { sku: 'sku-mug', qty: 2 });
await order.signal('cancel', 'changed my mind');
const view = await order.query('view');

// no call, no string building
const same = orders.get({ orderId: 'o-42' });
console.log(await same.result());
```

Handler names are **method names** from the workflow class; the contract maps them to the registered names. Unknown names, wrong argument types, missing arguments, missing ID template fields and undeclared search attributes are compile errors.

## `createClient(options?)`

```ts
function createClient(options?: ClientOptions): NornClient;

interface NornClient extends AsyncDisposable {
  workflow<C extends AnyWorkflowContract>(contract: C): WorkflowClient<C>;
  // the underlying @temporalio/client Client
  readonly temporal: Client;
  readonly connection: ConnectionLike;
  close(): Promise<void>;
}
```

| Option | Default | Description |
| --- | --- | --- |
| `address` | `TEMPORAL_ADDRESS`, then `localhost:7233` | Server address. |
| `namespace` | `TEMPORAL_NAMESPACE`, then `default` | Namespace. |
| `apiKey` | `TEMPORAL_API_KEY` | API key (Temporal Cloud). Turns TLS on. |
| `tls` | `TEMPORAL_TLS` | `true` turns TLS on without an API key. For mTLS, pass your own `connection`. |
| `tls` | none | The SDK's TLS options, e.g. `{ clientCertPair: { crt, key } }` for mTLS. |
| `connectTimeout` | SDK default | A `Duration`. |
| `connection` | lazy connection | An existing `Connection`. Norn does not close connections it did not open. |
| `client` | new client | An existing Temporal `Client` to wrap, such as a test environment's. Its interceptors are used as-is (no correlation interceptor is added). |
| `dataConverter` | SDK default | For example `clientDataConverter()` from `@norn/codec`. |
| `interceptors` | `[]` | Extra workflow client interceptors, after Norn's correlation interceptor. |
| `correlation` | `true` | Add the correlation ID header to outbound calls. |

The connection is created lazily: `createClient()` never blocks or fails, and the first call connects. `close()` (or `await using`) closes the connection only if Norn opened it. Create one client per process and share it.

## `WorkflowClient<C>`

```ts
interface WorkflowClient<C> {
  readonly contract: C;
  start(input, options?: StartOptions<C>): Promise<WorkflowHandle<C>>;
  execute(input, options?: StartOptions<C>): Promise<Output>;
  get(target: IdParams<C> | { workflowId: string; runId?: string }): WorkflowHandle<C>;
  signalWithStart(input, operation: { signal: K; args: [...] }, options?: StartOptions<C>): Promise<WorkflowHandle<C>>;
  updateWithStart(input, operation: { update: K; args: [...] }, options?: StartOptions<C>): Promise<{ handle: WorkflowHandle<C>; result: UpdateResult }>;
  list(query?: string): AsyncIterable<WorkflowSummary<C>>;
  count(query?: string): Promise<number>;
}
```

- The workflow ID comes from the contract's ID template and the input; `workflowId` overrides it and is required for contracts without a template. When `run()` takes no input, `input` is optional.
- `get()` makes no call. A handle without a run ID targets the latest run, so it keeps working across continue-as-new.
- `signalWithStart` signals the workflow, starting it first if it is not running; `input` is used only if it starts. Use it to feed entity workflows that may not exist yet.
- `updateWithStart` runs an update, starting the workflow first if needed (`ifRunning` defaults to `'useExisting'` here), and resolves once the update completes.
- `list()` and `count()` cover executions of the contract's workflow type; a [visibility query](https://docs.temporal.io/list-filter) narrows them (`list('CustomerId = "c-7" AND ExecutionStatus = "Running"')`).

```ts
await norn.workflow(LoyaltyWorkflow).signalWithStart({ customerId }, { signal: 'orderCompleted', args: [{ orderId, cents }] });

const { handle, result } = await norn.workflow(CartWorkflow).updateWithStart({ cartId: 'c-9' }, { update: 'add', args: ['sku-mug'] });
```

### `StartOptions<C>`

| Option | Description |
| --- | --- |
| `workflowId` | Overrides the ID built from the template. |
| `taskQueue` | Overrides the contract's task queue. |
| `ifRunning` | `'fail'` (default: `WorkflowAlreadyStartedError`), `'useExisting'` or `'terminateExisting'`. |
| `ifClosed` | Whether a closed workflow's ID may be reused: `'allow'` (default), `'allowIfFailed'` or `'reject'`. |
| `searchAttributes` | Initial search attributes, typed from the contract and checked at runtime against the declared types. |
| `memo` | Memo fields. |
| `executionTimeout`, `runTimeout`, `taskTimeout`, `startDelay` | `Duration`s. |
| `summary`, `details` | Text shown in the Temporal UI for this execution. |
| `retry` | A workflow retry policy (`RetryPolicy` from `@temporalio/common`). |
| `priority` | The SDK's `Priority`. |
| `correlationId` | Correlation ID for this call; defaults to the current one from `runWithCorrelationId()`. |

### `WorkflowHandle<C>`

| Member | Description |
| --- | --- |
| `workflowId`, `runId` | The IDs the handle points at (`runId` is `undefined` for `get()` without one). |
| `signal(method, ...args)` | Resolves once the server accepted the signal. |
| `query(method, ...args)` | Returns the query's typed result. |
| `update(method, ...args)` | Returns the update's typed result once the handler finishes. |
| `result()` | Waits for the workflow and returns its output. |
| `cancel()` | Requests cancellation. |
| `terminate(reason?)` | Ends the workflow without cleanup. |
| `describe()` | A `WorkflowSummary`: `workflowId`, `runId`, `type`, `status`, `taskQueue`, `startTime`, `closeTime`, `historyLength`, typed `searchAttributes`, `memo`. |
| `temporal` | The underlying SDK `WorkflowHandle`, for anything Norn does not wrap. |

`WorkflowStatus` is `'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TERMINATED' | 'CONTINUED_AS_NEW' | 'TIMED_OUT' | 'PAUSED' | 'UNKNOWN'`.

## Errors

Every call converts Temporal errors with `toNornError()`. The classes come from `@norn/core` and are re-exported here:

| Error | `code` | `status` | When |
| --- | --- | --- | --- |
| `WorkflowAlreadyStartedError` | `WORKFLOW_ALREADY_STARTED` | 409 | `start()` with an ID that is running (or closed, when `ifClosed` forbids reuse). |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | 404 | The workflow (or run) does not exist. |
| `WorkflowClosedError` | `WORKFLOW_CLOSED` | 409 | `signal`, `update`, `cancel` or `terminate` on a workflow that has finished. Has `closeStatus`. |
| `UpdateRejectedError` | `UPDATE_REJECTED` | 422 | A validator rejected the update, or its handler failed. Has `update` and `failureType`. |
| `QueryFailedError` | `QUERY_FAILED` | 500 | The query is not registered, was rejected or threw. |
| `WorkflowFailedError` | `WORKFLOW_FAILED` | 500 | `result()` / `execute()` of a failed workflow. `failureType` is the failure's type, or `'Cancelled'`, `'Terminated'`, `'TimedOut'`. |
| `TemporalUnavailableError` | `TEMPORAL_UNAVAILABLE` | 503 | gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED` or `RESOURCE_EXHAUSTED` (rate limited). |

Temporal reports signals, updates and cancels to a finished workflow as "not found"; Norn describes the workflow to tell a closed one (409) from one that never existed (404).

```ts
import { UpdateRejectedError, WorkflowClosedError } from '@norn/client';

try {
  await norn.workflow(PaymentWorkflow).get({ paymentId }).update('cancel', { by: userId });
} catch (error) {
  if (error instanceof UpdateRejectedError && error.failureType === 'AlreadySubmittedError') return tooLate();
  if (error instanceof WorkflowClosedError) return alreadyFinished(error.closeStatus);
  throw error;
}
```

`toNornError(error, ctx)` converts any Temporal client error (returning unknown errors unchanged, including gRPC errors from other services), and `failureTypeOf(cause)` names a failure the same way `WorkflowFailedError` does. With `@norn/hono`, `nornErrorHandler()` turns all of these into JSON responses.

## Correlation IDs

```ts
import { getCorrelationId, runWithCorrelationId } from '@norn/client';

await runWithCorrelationId(requestId, () => norn.workflow(OrderWorkflow).start(input));
```

Every start, signal, signal-with-start, query, update and update-with-start inside `runWithCorrelationId(id, fn)` carries `id` in the `norn-correlation-id` header. Norn workers forward it to activities, child workflows and continue-as-new runs, and `getCorrelationId()` from `@norn/activity` returns it inside activities. `correlationInterceptor()` is the client interceptor that adds the header, for use with a plain Temporal `Client`. The `@norn/hono` middleware sets the ID for every request.

## Lower-level helpers

- `startOptions(contract, input, options?)`: the Temporal `WorkflowStartOptions` (ID, task queue, args, conflict and reuse policies, typed search attributes, timeouts) that `start()` uses.
- `toTypedSearchAttributes(contract, values)`: converts `{ Name: value }` into Temporal's typed search attribute pairs, checked against the contract.
- `resolveWorkflowId(contract, input, explicit?)`: the workflow ID for an input, or the explicit one.

## API

| Export | Kind |
| --- | --- |
| `createClient(options?)` | Creates a `NornClient` |
| `ClientOptions`, `NornClient`, `WorkflowClient<C>`, `WorkflowHandle<C>`, `HandleTarget<C>`, `SignalOperation<C, K>`, `UpdateOperation<C, K>`, `WorkflowSummary<C>`, `WorkflowStatus` | Types |
| `StartOptions<C>`, `IfRunning`, `IfClosed` | Start option types |
| `startOptions(contract, input, options?)`, `toTypedSearchAttributes(contract, values)`, `resolveWorkflowId(contract, input, explicit?)` | Option helpers |
| `toNornError(error, ctx)`, `failureTypeOf(cause)`, `ErrorContext` | Error conversion |
| `NornError`, `WorkflowAlreadyStartedError`, `WorkflowNotFoundError`, `WorkflowClosedError`, `UpdateRejectedError`, `QueryFailedError`, `WorkflowFailedError`, `TemporalUnavailableError`, `isNornError`, `AnyWorkflowContract` | Re-exported from `@norn/core` |
| `runWithCorrelationId(id, fn)`, `getCorrelationId()`, `correlationInterceptor()` | Correlation IDs |

## License

MIT
