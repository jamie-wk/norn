---
title: "@norn-ts/testing"
description: Test environments, typed activity mocks, a fake client, replay checks and the Vitest decorator plugin.
sidebar:
  order: 7
---

Test helpers for Norn apps, at every level. For a walkthrough, see the [Testing guide](/norn/guides/testing/).

| Level | Tool | Needs Temporal |
| --- | --- | --- |
| Workflows, end to end | `createTestEnv()` / `useTestEnv()` with typed `mockActivities()` | a dev server or the time-skipping test server, downloaded automatically |
| Activities and services | the container from your registry plus `MockActivityEnvironment` | no |
| API routes | `createFakeClient()`: an in-memory `NornClient` with the real error rules | no |
| Deploy safety | `assertReplays()` with recorded histories | no server; replays locally |

The package has three entry points:

| Entry point | Contents |
| --- | --- |
| `@norn-ts/testing` | `createTestEnv()`, `mockActivities()`, `activityMap()`, `createFakeClient()`, `assertReplays()`, `loadHistories()` |
| `@norn-ts/testing/vitest` | `mockActivities()` with `vi.fn()` mocks, and a per-file `useTestEnv()` |
| `@norn-ts/testing/vite` | `standardDecorators()`, a Vite/Vitest plugin that compiles TC39 standard decorators |

## Install

```sh
pnpm add -D @norn-ts/testing @temporalio/testing @temporalio/worker @temporalio/client @temporalio/common
# for @norn-ts/testing/vitest and @norn-ts/testing/vite (optional peers):
pnpm add -D vitest esbuild
```

Requires Node 22.18+. The `@temporalio/*` peers are `^1.24.0`. `vitest` (3 or later) is needed only for `@norn-ts/testing/vitest`, and `esbuild` (0.21 or later) only for `@norn-ts/testing/vite`.

## Vitest setup: `@norn-ts/testing/vite`

Vite compiles TypeScript with Oxc, which leaves standard decorators in place, and Node cannot run them yet. `standardDecorators()` lowers them with esbuild before Vite's own transform:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { standardDecorators } from '@norn-ts/testing/vite';

export default defineConfig({
  plugins: [standardDecorators()],
  // workflow tests talk to a real server
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
```

```ts
function standardDecorators(options?: StandardDecoratorsOptions): DecoratorPlugin;
```

| Option | Default | Description |
| --- | --- | --- |
| `include` | `/\.[cm]?tsx?$/` | Files to transform. |
| `exclude` | `node_modules` | Files to skip even when they match `include`. |
| `target` | `'es2022'` | esbuild target used for lowering. |

Only files that contain a decorator are transformed. The plugin runs with `enforce: 'pre'` and emits source maps. Workflow code is bundled by the worker with its own settings and needs nothing extra.

## Workflow tests: `createTestEnv(options?)`

Starts a Temporal server, a Norn client and, with a registry, a worker for your workflows in the background:

```ts
import { expect, it } from 'vitest';
import { createTestEnv, mockActivities } from '@norn-ts/testing';
import { InventoryActivities, NotificationActivities, PaymentActivities } from '../.norn/activities.js';
import { OrderWorkflow } from '../.norn/contracts.js';
import { registry } from '../.norn/registry.js';

it('refunds when canceled during the window', async () => {
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

### Options

| Option | Default | Description |
| --- | --- | --- |
| `registry` | none | The generated registry. Without it, no worker runs. |
| `mode` | `'local'` | `'local'`: a real dev server (`temporal server start-dev`), timers take real time. `'time-skipping'`: Temporal's test server, which skips ahead to the next timer while the test waits on a result. Any other value throws `NornConfigError`. |
| `activities` | none | Mocks from `mockActivities()`, plain `{ 'payments.charge': fn }` records, or a list of either. Names must be registered (the worker throws `NornConfigError` otherwise); activities you don't mock run for real through the container. |
| `container` | none | `{ overrides?, errors? }`, e.g. `{ overrides: [[PaymentGateway, fakeGateway]] }`. |
| `searchAttributes` | none | Search attributes to register in addition to the registry's, as `{ Name: 'keyword' }`. |
| `taskQueues` | all | Poll a subset of the registry's queues. |
| `worker` | `true` | `false` to skip the worker, e.g. to test starts and signals only. |
| `dataConverter` | SDK default | Worker data converter, e.g. `createDataConverter()` from `@norn-ts/codec`. |
| `clientDataConverter` | SDK default | Client data converter, e.g. `clientDataConverter()` from `@norn-ts/codec`. |
| `serverPath` | `NORN_TEMPORAL_CLI_PATH` / `NORN_TEMPORAL_TEST_SERVER_PATH` | An existing `temporal` CLI (local) or test server (time-skipping) binary. Without either, the SDK downloads one. |
| `logLevel` | `NORN_TEST_LOG_LEVEL`, then `'WARN'` | SDK log level. Applied once per process, and only if no runtime is installed yet. |

### `TestEnv`

```ts
interface TestEnv extends AsyncDisposable {
  // from @temporalio/testing
  readonly temporal: TestWorkflowEnvironment;
  readonly client: NornClient;
  readonly worker: NornWorker | undefined;
  readonly mode: 'local' | 'time-skipping';
  // client.workflow(contract)
  workflow<C extends AnyWorkflowContract>(contract: C): WorkflowClient<C>;
  // skips time, or sleeps for real in local mode
  sleep(duration: Duration): Promise<void>;
  teardown(): Promise<void>;
}
```

The registry's search attributes are registered on the server and awaited (up to 30 seconds), so visibility queries and `list()` work in local mode. The worker runs with signal handling, health checks and versioning off and a 5-second shutdown grace time, and workflows are bundled once per process. Dispose the environment with `await using` or `await env.teardown()`; calling `teardown()` twice is safe.

```ts
const invite = await env.workflow(SubcontractorInvitation).start(input);
await env.sleep('3 days');
expect(await invite.query('view')).toMatchObject({ remindersSent: 1 });
```

## Activity mocks

### `mockActivities(ref, impls)`

```ts
function mockActivities<R extends ActivitiesRef, const I extends ActivityImpls<R>>(ref: R, impls: I): MockedActivities<R, { [K in keyof I]: RecordedFn<...> }>;
```

Replaces some methods of an activity reference (from `.norn/activities.ts` or `defineActivities()`) with test functions, typed from the activity class: unknown method names and wrong parameter or return types are compile errors. At runtime, a value that isn't an activity reference, an unknown method name or a non-function mock throws `NornConfigError`. Each mock records its arguments in `.calls`. Pass the result to `createTestEnv({ activities })`; mock only what you need.

### `activityMap(sources)`

Flattens mock sets and plain records (or a list of them) into one `{ registeredName: fn }` map. A non-function value throws `NornConfigError`. `createTestEnv()` uses it for `activities`.

## `@norn-ts/testing/vitest`

```ts
import { describe, expect, it } from 'vitest';
import { mockActivities, useTestEnv } from '@norn-ts/testing/vitest';

const notify = mockActivities(NotificationActivities, { email: async () => ({ messageId: 'm' }) });
const env = useTestEnv({ registry, mode: 'time-skipping', activities: notify });

describe('DailyReportWorkflow', () => {
  it('emails the report', async () => {
    expect(await env.workflow(DailyReportWorkflow).execute()).toBe('sent');
    expect(notify.email).toHaveBeenCalledWith('ops@example.com', 'daily_report', {});
  });
});
```

| Export | Description |
| --- | --- |
| `mockActivities(ref, impls)` | As above, but every mock is a `vi.fn()`, so `toHaveBeenCalledWith` and friends work. |
| `useTestEnv(options?)` | One environment per test file, created in `beforeAll` (120 s timeout) and torn down in `afterAll`. Takes the same options as `createTestEnv()`. |

The object `useTestEnv()` returns forwards to the environment, which exists only inside tests and hooks; accessing it elsewhere throws. Give each test its own workflow IDs, and call `vi.clearAllMocks()` between tests if you assert on counts.

:::note
This entry point exports only `mockActivities` and `useTestEnv`. Import `createTestEnv`, `createFakeClient` and the types from `@norn-ts/testing`.
:::

## Activity tests

Activities are plain classes; construct them with fakes. To test one as the worker runs it (dependency injection, scopes, [error mapping](/norn/reference/activity/#error-mapping)), build the container from the registry and run the registered function in `MockActivityEnvironment` from `@temporalio/testing`:

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

An in-memory `NornClient` for testing API routes without Temporal. It enforces the same rules and throws the same errors as a real server:

- `WorkflowAlreadyStartedError` for duplicates, honoring `ifRunning` and `ifClosed`.
- `WorkflowNotFoundError` for unknown IDs.
- `WorkflowClosedError` for signals, updates, cancels and terminates to finished workflows. Queries still work on closed workflows.
- ID templates, through the contract.

```ts
import { createFakeClient } from '@norn-ts/testing';
import { UpdateRejectedError } from '@norn-ts/client';

const fake = createFakeClient();
// e.g. app.use(temporal({ client: fake }))
const app = createApp({ client: fake });

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
| `started(contract)` | Inputs of every new execution of a contract, including with-start. Rejected, failed and reused starts are not counted. |
| `stub(contract, { signals?, queries?, updates?, onStart? })` | Handler implementations, typed from the contract. Queries and updates without a stub throw `NornConfigError`; signals without one are recorded and accepted. `onStart(input, workflowId)` runs for each new execution, e.g. to call `fake.complete()`. A second `stub()` for the same contract replaces the first. |
| `complete(workflowId, result)` | Completes the latest run, so `result()` resolves. |
| `fail(workflowId, failureType, message?)` | Fails the latest run, so `result()` throws `WorkflowFailedError`. `message` defaults to `failureType`. |
| `failNext(error)` | Makes the next call reject, e.g. with `TemporalUnavailableError`. Calls are still recorded. |
| `reset()` | Clears calls, executions, stubs and pending failures. |

`complete()` and `fail()` throw `NornConfigError` for a workflow ID the fake has never started. `signalWithStart` reuses a running execution; `updateWithStart` defaults to `ifRunning: 'useExisting'`. `cancel()` and `terminate()` close the run, so `result()` throws `WorkflowFailedError`. `describe()`, `list()` and `count()` read the in-memory executions. `temporal` and `connection` (and a handle's `temporal`) throw on access, since there is nothing behind the fake; `close()` does nothing.

## Replay tests

```ts
import { fileURLToPath } from 'node:url';
import { assertReplays, loadHistories } from '@norn-ts/testing';

it('replays recorded production histories', async () => {
  const histories = await loadHistories(fileURLToPath(new URL('./histories', import.meta.url)));
  await assertReplays(histories, { registry });
}, 120_000);
```

| Function | Description |
| --- | --- |
| `loadHistories(dir)` | Reads every `.json` file in `dir`, in file-name order. Each is either a raw history (as written by [`norn histories pull`](/norn/reference/cli/), the Temporal UI or `temporal workflow show --output json`; the workflow ID is the file name) or `{ workflowId, history }`. Invalid JSON throws `NornConfigError`. Resolves with `RecordedHistory[]`. |
| `assertReplays(histories, { registry \| workflowsPath, dataConverter? })` | Bundles the current workflows, replays every history, and throws one error listing each execution that would hit a non-determinism error. Resolves with `{ replayed }`. Pass the workers' `dataConverter` if payloads are encrypted. Throws `NornConfigError` for an empty history list or when neither `registry` nor `workflowsPath` is given. |

See [Replay tests](/norn/guides/versioning/#replay-tests) for recording histories and running this in CI.

## Exports

| Export | Kind |
| --- | --- |
| `createTestEnv(options?)`, `TestEnv`, `TestEnvOptions`, `TestEnvMode` | Test environment |
| `mockActivities(ref, impls)`, `activityMap(sources)`, `ActivityImpls`, `ActivitySource`, `MockedActivities`, `RecordedFn` | Activity mocks |
| `createFakeClient()`, `FakeNornClient`, `FakeStub`, `FakeCall`, `FakeOp` | Fake client |
| `assertReplays(histories, options)`, `loadHistories(dir)`, `RecordedHistory`, `ReplayOptions` | Replay tests |
| `@norn-ts/testing/vitest`: `mockActivities(ref, impls)`, `useTestEnv(options?)` | Vitest helpers |
| `@norn-ts/testing/vite`: `standardDecorators(options?)`, `StandardDecoratorsOptions`, `DecoratorPlugin` | Decorator plugin |
