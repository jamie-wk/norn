---
title: "Testing"
---

`@norn-ts/testing` covers four levels of tests:

| Level | Tool | Needs Temporal |
| --- | --- | --- |
| Workflow logic, end to end | `createTestEnv()` / `useTestEnv()` with `mockActivities()` | a test server (downloaded automatically) |
| Activities and services | the container plus `MockActivityEnvironment` | no |
| API routes | `createFakeClient()` | no |
| Deploy safety | `assertReplays()` with recorded histories | no server; the replayer runs locally |

## Setup: Vitest and decorators

Vitest uses Vite, which compiles TypeScript with Oxc and leaves TC39 decorators untouched; Node can't run them yet. Add the plugin from `@norn-ts/testing/vite`, which lowers decorators with esbuild before Vite's own transform:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { standardDecorators } from '@norn-ts/testing/vite';

export default defineConfig({
  plugins: [standardDecorators()],
  test: {
    // workflow tests talk to a real server
    testTimeout: 60_000,
    // the first run downloads it
    hookTimeout: 120_000,
  },
});
```

`standardDecorators({ include, exclude, target })` transforms `.ts`/`.tsx` files outside `node_modules` that contain a decorator, targeting `es2022` by default. It needs `esbuild` installed (a peer dependency).

Workflow code itself is bundled by the worker with its own compiler settings, so it needs nothing extra.

## Workflow tests: `createTestEnv()`

`createTestEnv()` starts a Temporal test server, a Norn client, and (with a registry) a worker for your workflows in the background:

```ts
import { expect, it } from 'vitest';
import { createTestEnv, mockActivities } from '@norn-ts/testing';
import { NotificationActivities, PaymentActivities } from '../.norn/activities';
import { OrderWorkflow } from '../.norn/contracts';
import { registry } from '../.norn/registry';

it('refunds when the customer cancels inside the window', async () => {
  const payments = mockActivities(PaymentActivities, {
    charge: async (orderId, amountCents) => ({ chargeId: `ch_${orderId}`, amountCents }),
    refund: async () => ({ refundId: 're_1' }),
  });
  const notify = mockActivities(NotificationActivities, { email: async () => ({ messageId: 'm_1' }) });

  await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: [payments, notify] });

  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', customerId: 'c-1', email: 'a@b.c', card: 'tok', items: [{ sku: 'sku-mug', qty: 1 }] });
  await order.signal('cancel', 'changed my mind');
  expect((await order.result()).status).toBe('refunded');
  expect(payments.refund.calls).toEqual([['o-1', 'ch_o-1']]);
});
```

### Modes

- **`'local'`** (default): a real Temporal dev server (`temporal server start-dev`). Timers take real time. Search attributes from the registry (plus `searchAttributes`) are registered for you, so visibility queries work. Use it for search-attribute and `list()` tests, and anything where real time is fine.
- **`'time-skipping'`**: Temporal's test server. While the test waits on a workflow result, the server skips ahead to the next timer, so a workflow that sleeps for 14 days finishes in milliseconds. Use it for timers, reminders, expiries and SLAs. Search attributes are registered here too.

`env.sleep(duration)` advances time explicitly: it skips on the time-skipping server and sleeps for real on the dev server. Use it to observe a workflow mid-way:

```ts
const invite = await env.workflow(SubcontractorInvitation).start(input);
await env.sleep('3 days');
expect(await invite.query('view')).toMatchObject({ status: 'pending', remindersSent: 1 });
await env.sleep('12 days');
expect((await invite.result()).status).toBe('expired');
```

Servers are downloaded on first use and cached. To use existing binaries (offline CI, sandboxes), set `NORN_TEMPORAL_CLI_PATH` (a `temporal` CLI, for local mode) or `NORN_TEMPORAL_TEST_SERVER_PATH` (for time-skipping), or pass `serverPath`. SDK logs are quiet (`WARN`) unless you set `logLevel` or `NORN_TEST_LOG_LEVEL`.

### Options

| Option | Description |
| --- | --- |
| `registry` | The generated registry. Without it, no worker runs. |
| `mode` | `'local'` (default) or `'time-skipping'`. |
| `activities` | Mocks from `mockActivities()`, plain `{ 'payments.charge': fn }` records, or a list of either. Names must be registered activities; unmocked activities run for real through the container. |
| `container` | `{ overrides, errors }`: replace services or providers, such as `{ overrides: [[TransferService, fakeTransfers]] }`. |
| `searchAttributes` | Extra search attributes to register on the server, in addition to the registry's. |
| `taskQueues` | Poll a subset of the registry's queues. |
| `worker` | `false` to skip the worker, to test starts and signals only. |
| `dataConverter`, `clientDataConverter` | For workflows using [`@norn-ts/codec`](/norn/guides/encryption/). |
| `serverPath`, `logLevel` | See above. |

The environment has `client` (a `NornClient`), `workflow(contract)` (shorthand for `client.workflow()`), `worker`, `temporal` (the SDK's `TestWorkflowEnvironment`), `mode`, `sleep()` and `teardown()`. Dispose it with `await using` or `await env.teardown()`.

### Mocking activities

`mockActivities(ref, impls)` replaces some methods of an activity reference with test functions. The implementations are **typed from the activity class**: parameters and return types must match, and unknown method names are compile errors. Each mock records its calls in `.calls`:

```ts
const transfers = mockActivities(TransferActivities, {
  submit: async (request) => ({ transferId: `tr_${request.paymentId}`, status: 'pending' }),
});
// ...
expect(transfers.submit.calls).toHaveLength(1);
expect(transfers.submit.calls[0]![0]).toMatchObject({ amountCents: 50_000 });
```

Mock only what you need: the rest of the reference's activities, and every other activity class, still run through the real container. Combine with `container.overrides` to fake a service instead of a whole activity.

### Vitest helpers

`@norn-ts/testing/vitest` has the same `mockActivities()`, but every mock is a `vi.fn()` so you get `toHaveBeenCalledWith` and friends, plus `useTestEnv()`, which creates one environment per test file in `beforeAll` and tears it down in `afterAll`:

```ts
import { describe, expect, it } from 'vitest';
import { mockActivities, useTestEnv } from '@norn-ts/testing/vitest';

const notify = mockActivities(InvitationActivities, {
  sendInvitation: async () => ({ messageId: 'm1' }),
  sendReminder: async () => ({ messageId: 'm2' }),
});
const env = useTestEnv({ registry, mode: 'time-skipping', activities: notify });

describe('SubcontractorInvitation', () => {
  it('sends two reminders before expiring', async () => {
    const invite = await env.workflow(SubcontractorInvitation).start(input);
    expect((await invite.result()).status).toBe('expired');
    expect(notify.sendReminder).toHaveBeenCalledTimes(2);
  });
});
```

Access `env` only inside tests and hooks; it is created lazily. Because the environment is shared within the file, give each test its own workflow IDs, and reset mocks between tests if you assert on counts (`beforeEach(() => vi.clearAllMocks())`).

## Testing activities

Activities are plain classes, so the simplest test constructs one with fakes:

```ts
const activities = new PaymentActivities(fakeGateway);
expect(await activities.charge('o-1', 500, 'tok')).toEqual({ chargeId: 'ch_o-1', amountCents: 500 });
```

If the activity uses context helpers (`heartbeat()`, `idempotencyKey()`, `cancellationSignal()`), run it inside the SDK's `MockActivityEnvironment` from `@temporalio/testing`. To test it **as the worker runs it**, with dependency injection, scoping and [error mapping](/norn/guides/errors/#activity-errors), build the container from the registry and call the registered function:

```ts
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { registry } from '../.norn/registry';
import { PaymentGateway } from '../src/services/payment-gateway';

it('makes declined cards non-retryable', async () => {
  await using container = registry.createContainer({ overrides: [[PaymentGateway, decliningGateway]] });
  const activities = await container.activities();

  const env = new MockActivityEnvironment({ attempt: 1 });
  const error = await env.run(activities['payments.charge']!, 'o-1', 500, 'tok').catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ApplicationFailure);
  expect(error).toMatchObject({ type: 'PaymentDeclinedError', nonRetryable: true });
});
```

`MockActivityEnvironment` also lets you observe heartbeats (`env.on('heartbeat', ...)`) and cancel the activity (`env.cancel()`).

## API tests: `createFakeClient()`

API routes shouldn't need a Temporal server to test. `createFakeClient()` is an in-memory `NornClient` that enforces the same rules and throws the same errors as the real one: 409 for duplicate starts and closed workflows, 404 for unknown IDs, `ifRunning` / `ifClosed` semantics, ID templates.

```ts
import { expect, it } from 'vitest';
import { createFakeClient } from '@norn-ts/testing';
import { UpdateRejectedError } from '@norn-ts/client';
import { buildApp } from '../src/api';
import { PaymentWorkflow } from '../.norn/contracts';

it('starts a payment and rejects a duplicate', async () => {
  const fake = createFakeClient();
  // e.g. app.use(temporal({ client: fake }))
  const app = buildApp(fake);

  const first = await app.request('/payments', { method: 'POST', body: JSON.stringify({ paymentId: 'p1', amountCents: 500 }) });
  expect(first.status).toBe(201);
  expect(fake.started(PaymentWorkflow)).toEqual([{ paymentId: 'p1', amountCents: 500 }]);

  const dup = await app.request('/payments', { method: 'POST', body: JSON.stringify({ paymentId: 'p1', amountCents: 500 }) });
  expect(dup.status).toBe(409);
});

it('maps a rejected cancel to 422', async () => {
  const fake = createFakeClient();
  fake.stub(PaymentWorkflow, {
    updates: {
      cancel: () => {
        throw new UpdateRejectedError({ workflowId: 'payment-p1', update: 'cancel', failureType: 'AlreadySubmittedError', message: 'already submitted' });
      },
    },
  });
  await fake.workflow(PaymentWorkflow).start({ paymentId: 'p1', amountCents: 500 });
  const res = await buildApp(fake).request('/payments/p1/cancel', { method: 'POST' });
  expect(res.status).toBe(422);
});
```

| Fake API | Description |
| --- | --- |
| `calls` | Every call, in order: `{ op, workflow, workflowId, name?, args?, input?, options? }`. |
| `started(contract)` | Inputs of every new execution of a contract, including with-start. Rejected, failed and reused starts are not counted. |
| `stub(contract, { signals, queries, updates, onStart })` | Implementations for handlers. Queries and updates without a stub throw; signals without one are accepted and recorded. |
| `complete(workflowId, result)` / `fail(workflowId, failureType, message?)` | Finish the latest run, so `result()` resolves or throws `WorkflowFailedError`. |
| `failNext(error)` | Make the next call reject, for example with `TemporalUnavailableError`. |
| `reset()` | Clear everything. |

## Replay tests

`assertReplays(histories, { registry })` replays recorded histories against the current workflow code and fails on any non-determinism; `loadHistories(dir)` reads them from a directory. See [Versioning & safe deploys](/norn/guides/versioning/#replay-tests).

## Running the suites

A practical split:

```json
{
  "scripts": {
    "test": "norn gen --check && vitest run --project unit",
    "test:workflows": "vitest run --project workflows"
  }
}
```

with Vitest projects separating fast unit tests (activities, API, fake client) from workflow tests that start a server, and `pool: 'forks'` for the latter so each file gets its own process and Temporal runtime.
