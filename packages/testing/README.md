# @norn/testing

Test helpers for [Norn](https://jamie-wk.github.io/norn/) apps, at every level:

| Level | Tool | Needs Temporal |
| --- | --- | --- |
| Workflows, end to end | `createTestEnv()` / `useTestEnv()` with typed `mockActivities()` | a dev server or the time-skipping test server, downloaded automatically |
| Activities and services | the container from your registry plus `MockActivityEnvironment` | no |
| API routes | `createFakeClient()`: an in-memory `NornClient` with the real error rules | no |
| Deploy safety | `assertReplays()` with recorded histories | no server; replays locally |

Plus `@norn/testing/vite`, a Vite/Vitest plugin that compiles TC39 standard decorators, and `@norn/testing/vitest`, with `vi.fn()` mocks and a per-file `useTestEnv()`.

## Install

```sh
pnpm add -D @norn/testing @temporalio/testing @temporalio/worker @temporalio/client @temporalio/common
# for @norn/testing/vitest and @norn/testing/vite (optional peers):
pnpm add -D vitest esbuild
```

Requires Node 22.18+. `vitest` (3 or later) is needed only for `@norn/testing/vitest`, and `esbuild` only for `@norn/testing/vite`.

## Vitest setup: `@norn/testing/vite`

Vite compiles TypeScript with Oxc, which leaves standard decorators in place, and Node cannot run them yet. `standardDecorators()` lowers them with esbuild before Vite's own transform:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { standardDecorators } from '@norn/testing/vite';

export default defineConfig({
  plugins: [standardDecorators()],
  test: { testTimeout: 60_000, hookTimeout: 120_000 }, // workflow tests talk to a real server
});
```

```ts
function standardDecorators(options?: { include?: RegExp; exclude?: RegExp; target?: string }): DecoratorPlugin;
```

It transforms files matching `include` (default `/\.[cm]?tsx?$/`) outside `exclude` (default `node_modules`) that contain a decorator, targeting `es2022` by default. Workflow code is bundled by the worker with its own settings and needs nothing extra.

## Workflow tests: `createTestEnv(options?)`

Starts a Temporal server, a Norn client and, with a registry, a worker for your workflows in the background:

```ts
import { expect, it } from 'vitest';
import { createTestEnv, mockActivities } from '@norn/testing';
import { InventoryActivities, NotificationActivities, PaymentActivities } from '../.norn/activities.js';
import { OrderWorkflow } from '../.norn/contracts.js';
import { registry } from '../.norn/registry.js';

it('refunds when cancelled during the window', async () => {
  const payments = mockActivities(PaymentActivities, {
    charge: async (orderId, amountCents) => ({ chargeId: `ch-${orderId}`, amountCents }),
    refund: async () => ({ refundId: 're-1' }),
  });
  const inventory = mockActivities(InventoryActivities, {
    reserve: async (_orderId, items) => ({ totalCents: items.length * 1_500 }),
    release: async () => undefined,
  });
  const notify = mockActivities(NotificationActivities, { email: async () => ({ messageId: 'm' }) });

  await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: [payments, inventory, notify] });

  const input = { orderId: 'o-1', customerId: 'c-1', email: 'a@example.com', card: 'tok', items: [{ sku: 'sku-book', qty: 1 }], cancelWindow: '1 day' };
  const order = await env.workflow(OrderWorkflow).start(input);
  await expect.poll(async () => (await order.query('view')).status).toBe('paid');
  await order.signal('cancel', 'changed my mind');
  expect(await order.result()).toMatchObject({ status: 'refunded' });
  expect(payments.refund.calls).toEqual([['o-1', 'ch-o-1']]);
});
```

| Option | Description |
| --- | --- |
| `registry` | The generated registry. Without it, no worker runs. |
| `mode` | `'local'` (default): a real dev server (`temporal server start-dev`), timers take real time. `'time-skipping'`: Temporal's test server, which skips ahead to the next timer while the test waits on a result. |
| `activities` | Mocks from `mockActivities()`, plain `{ 'payments.charge': fn }` records, or a list of either. Names must be registered; activities you don't mock run for real through the container. |
| `container` | `{ overrides?, errors? }`, e.g. `{ overrides: [[PaymentGateway, fakeGateway]] }`. |
| `searchAttributes` | Search attributes to register in addition to the registry's. |
| `taskQueues` | Poll a subset of the registry's queues. |
| `worker` | `false` to skip the worker. |
| `dataConverter` | Worker data converter, e.g. `createDataConverter()` from `@norn/codec`. |
| `clientDataConverter` | Client data converter, e.g. `clientDataConverter()` from `@norn/codec` (local mode; time-skipping mode uses the test server's client). |
| `serverPath` | An existing `temporal` CLI (local) or test server (time-skipping) binary. Defaults to `NORN_TEMPORAL_CLI_PATH` / `NORN_TEMPORAL_TEST_SERVER_PATH`, otherwise the SDK downloads one. |
| `logLevel` | SDK log level. Default `WARN`, or `NORN_TEST_LOG_LEVEL`. |

```ts
interface TestEnv extends AsyncDisposable {
  readonly temporal: TestWorkflowEnvironment; // from @temporalio/testing
  readonly client: NornClient;
  readonly worker: NornWorker | undefined;
  readonly mode: 'local' | 'time-skipping';
  workflow<C extends AnyWorkflowContract>(contract: C): WorkflowClient<C>; // client.workflow(contract)
  sleep(duration: Duration): Promise<void>; // skips time, or sleeps for real in local mode
  teardown(): Promise<void>;
}
```

The registry's search attributes are registered on the server and awaited, so visibility queries and `list()` work in local mode. The worker runs with signal handling, health checks and versioning off, and workflows are bundled once per process. Dispose the environment with `await using` or `await env.teardown()`.

```ts
const invite = await env.workflow(SubcontractorInvitation).start(input);
await env.sleep('3 days');
expect(await invite.query('view')).toMatchObject({ remindersSent: 1 });
```

### `mockActivities(ref, impls)`

```ts
function mockActivities<R extends ActivitiesRef, const I extends ActivityImpls<R>>(ref: R, impls: I): MockedActivities<R, { [K in keyof I]: RecordedFn<...> }>;
```

Replaces some methods of an activity reference (from `.norn/activities.ts`) with test functions, typed from the activity class: unknown method names and wrong parameter or return types are compile errors. Each mock records its arguments in `.calls`. Pass the result to `createTestEnv({ activities })`; mock only what you need. `activityMap(sources)` flattens mock sets and plain records into one `{ registeredName: fn }` map.

## `@norn/testing/vitest`

```ts
import { describe, expect, it } from 'vitest';
import { mockActivities, useTestEnv } from '@norn/testing/vitest';

const notify = mockActivities(NotificationActivities, { email: async () => ({ messageId: 'm' }) });
const env = useTestEnv({ registry, mode: 'time-skipping', activities: notify });

describe('DailyReportWorkflow', () => {
  it('emails the report', async () => {
    expect(await env.workflow(DailyReportWorkflow).execute()).toBe('sent');
    expect(notify.email).toHaveBeenCalledWith('ops@example.com', 'daily_report', {});
  });
});
```

- `mockActivities(ref, impls)`: as above, but every mock is a `vi.fn()`, so `toHaveBeenCalledWith` and friends work.
- `useTestEnv(options?)`: one environment per test file, created in `beforeAll` (120 s timeout) and torn down in `afterAll`. Access it only inside tests and hooks. Give each test its own workflow IDs, and `vi.clearAllMocks()` between tests if you assert on counts.
- `createTestEnv` and `createFakeClient` are re-exported for convenience.

## Activity tests

Activities are plain classes; construct them with fakes. To test one as the worker runs it (dependency injection, scopes, [error mapping](../activity/README.md#error-mapping)), build the container from the registry and run the registered function in `MockActivityEnvironment` from `@temporalio/testing`:

```ts
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';

it('makes declined cards non-retryable', async () => {
  await using container = registry.createContainer({ overrides: [[PaymentGateway, decliningGateway]] });
  const activities = await container.activities();
  const error = await new MockActivityEnvironment().run(activities['payments.charge']!, 'o-1', 500, 'tok').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApplicationFailure);
  expect(error).toMatchObject({ type: 'PaymentDeclinedError', nonRetryable: true });
});
```

## API tests: `createFakeClient()`

An in-memory `NornClient` for testing API routes without Temporal. It enforces the same rules and throws the same errors as a real server: `WorkflowAlreadyStartedError` for duplicates (honouring `ifRunning` and `ifClosed`), `WorkflowNotFoundError` for unknown IDs, `WorkflowClosedError` for signals, updates and cancels to finished workflows, and ID templates.

```ts
import { createFakeClient } from '@norn/testing';
import { UpdateRejectedError } from '@norn/client';

const fake = createFakeClient();
const app = createApp({ client: fake }); // e.g. app.use(temporal({ client: fake }))

fake.stub(OrderWorkflow, {
  updates: {
    addItem: () => {
      throw new UpdateRejectedError({ workflowId: 'order-o-1', update: 'addItem', failureType: 'InvalidItemError', message: 'Unknown SKU' });
    },
  },
});

await app.request('/orders', { method: 'POST', body: JSON.stringify(order) });
expect(fake.started(OrderWorkflow)).toEqual([order]);
expect((await app.request('/orders/o-1/items', { method: 'POST', body: '{"sku":"nope","qty":1}' })).status).toBe(422);
```

| Member | Description |
| --- | --- |
| `calls` | Every call in order: `{ op, workflow, workflowId, name?, args?, input?, options? }`. `op` is `'start'`, `'signal'`, `'query'`, `'update'`, `'cancel'`, `'terminate'`, `'signalWithStart'` or `'updateWithStart'`. |
| `started(contract)` | Inputs of every start (including with-start) of a contract. |
| `stub(contract, { signals?, queries?, updates?, onStart? })` | Handler implementations, typed from the contract. Queries and updates without a stub throw; signals without one are recorded and accepted. |
| `complete(workflowId, result)` | Completes the latest run, so `result()` resolves. |
| `fail(workflowId, failureType, message?)` | Fails the latest run, so `result()` throws `WorkflowFailedError`. |
| `failNext(error)` | Makes the next call reject, e.g. with `TemporalUnavailableError`. |
| `reset()` | Clears calls, executions, stubs and pending failures. |

`temporal` and `connection` throw on access, since there is nothing behind the fake.

## Replay tests

```ts
import { fileURLToPath } from 'node:url';
import { assertReplays, loadHistories } from '@norn/testing';

it('replays recorded production histories', async () => {
  const histories = await loadHistories(fileURLToPath(new URL('./histories', import.meta.url)));
  await assertReplays(histories, { registry });
}, 120_000);
```

- `loadHistories(dir)`: reads every `.json` file in `dir`, either a raw history (as written by `norn histories pull`, the Temporal UI or `temporal workflow show --output json`; the workflow ID is the file name) or `{ workflowId, history }`.
- `assertReplays(histories, { registry | workflowsPath, dataConverter? })`: bundles the current workflows, replays every history, and throws one error listing each execution that would hit a non-determinism error. Resolves with `{ replayed }`. Pass the workers' `dataConverter` if payloads are encrypted.

## API

| Export | Kind |
| --- | --- |
| `createTestEnv(options?)`, `TestEnv`, `TestEnvOptions`, `TestEnvMode` | Test environment |
| `mockActivities(ref, impls)`, `activityMap(sources)`, `ActivityImpls`, `ActivitySource`, `MockedActivities`, `RecordedFn` | Activity mocks |
| `createFakeClient()`, `FakeNornClient`, `FakeStub`, `FakeCall`, `FakeOp` | Fake client |
| `assertReplays(histories, options)`, `loadHistories(dir)`, `RecordedHistory`, `ReplayOptions` | Replay tests |
| `@norn/testing/vitest`: `mockActivities(ref, impls)`, `useTestEnv(options?)`, plus `createTestEnv`, `createFakeClient`, `TestEnv`, `TestEnvOptions`, `FakeNornClient` | Vitest helpers |
| `@norn/testing/vite`: `standardDecorators(options?)`, `StandardDecoratorsOptions`, `DecoratorPlugin` | Decorator plugin |

## License

MIT
