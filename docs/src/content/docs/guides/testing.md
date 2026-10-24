---
title: "Testing"
description: Run workflows on Temporal's time-skipping server with fake activities, unit-test activities as plain classes, and set up Vitest for decorators.
---

Two kinds of tests cover most of a Norn app:

| What | How | Needs Temporal |
| --- | --- | --- |
| Workflow logic, end to end | `useTestEnv()` / `createTestEnv()` with fake activities | a test server, downloaded automatically |
| Activities | plain unit tests: `new PaymentActivities(fakeGateway)` | no |

## Setup: Vitest and decorators

Vitest uses Vite, which leaves TC39 decorators untouched, and Node can't run them yet. Add the plugin from `@norn-ts/norn/vite`, which lowers decorators with esbuild before Vite's own transform:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { standardDecorators } from '@norn-ts/norn/vite';

export default defineConfig({
  plugins: [standardDecorators()],
  test: {
    testTimeout: 60_000, // workflow tests talk to a real server
    hookTimeout: 120_000, // the first run downloads it
  },
});
```

`standardDecorators({ include, exclude, target })` transforms `.ts` files outside `node_modules` that contain a decorator, targeting `es2022` by default. It needs `esbuild` installed. Workflow code is bundled by the worker with its own compiler settings, so it needs nothing extra.

## Workflow tests

`useTestEnv()` starts a Temporal test server, a client and a worker for the file, in `beforeAll`, and tears them down in `afterAll`. Pass your workflows module and fake activities, in the same shape as `createWorker()`:

```ts
// test/order.workflow.test.ts
import { expect, it, vi } from 'vitest';
import { useTestEnv } from '@norn-ts/norn/vitest';
import { OrderWorkflow } from '../src/workflows/order.workflow';

const payments = {
  charge: vi.fn(async (orderId: string, cents: number) => ({ id: `ch_${orderId}`, cents })),
  refund: vi.fn(async (_chargeId: string) => true),
};

const env = useTestEnv({
  workflows: new URL('../src/workflows/index.ts', import.meta.url),
  activities: { payments },
  mode: 'time-skipping',
});

it('keeps the charge when nobody cancels', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500 });
  expect(await order.result()).toBe('paid'); // the 5-minute window passes instantly
  expect(payments.refund).not.toHaveBeenCalled();
});

it('refunds when canceled within the window', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-2', cents: 500 });
  await order.signal('cancel', 'test');
  expect(await order.result()).toBe('refunded');
  expect(payments.refund).toHaveBeenCalledWith('ch_o-2');
});
```

Fakes are just objects. Pass real instances (`{ payments: new PaymentActivities(fakeGateway) }`) to test through your activity code, or a mix of both. Only the activities the workflow calls need to exist.

To type a fake against the class, use `satisfies`: `const payments = { charge: vi.fn(...) } satisfies Partial<PaymentActivities>`.

`createTestEnv()` is the same without Vitest's hooks. Dispose it with `await using`:

```ts
import { createTestEnv } from '@norn-ts/norn/testing';

await using env = await createTestEnv({ workflows, activities: { payments } });
```

### Modes

- **`'local'`** (default): a real Temporal dev server. Timers take real time. The search attributes your workflows declare are registered for you, so visibility queries such as `list()` work.
- **`'time-skipping'`**: Temporal's test server. While the test waits on a workflow result, the server skips ahead to the next timer, so a workflow that sleeps for 14 days finishes in milliseconds. Use it for timers, reminders, expiries and SLAs.

`env.sleep(duration)` advances time explicitly: it skips on the time-skipping server and sleeps for real on the dev server. Use it to observe a workflow midway:

```ts
const invite = await env.workflow(InvitationWorkflow).start(input);
await env.sleep('3 days');
expect(await invite.query('view')).toMatchObject({ status: 'pending', remindersSent: 1 });
await env.sleep('12 days');
expect((await invite.result()).status).toBe('expired');
```

Servers are downloaded on first use and cached. To use existing binaries (offline CI, sandboxes), set `NORN_TEMPORAL_CLI_PATH` (a `temporal` CLI, for local mode) or `NORN_TEMPORAL_TEST_SERVER_PATH` (for time-skipping), or pass `serverPath`. SDK logs are quiet (`WARN`) unless you set `logLevel` or `NORN_TEST_LOG_LEVEL`.

### Options

| Option | Description |
| --- | --- |
| `workflows` | The module exporting your `@Workflow` classes. Without it, no worker runs. |
| `activities` | Activity objects by namespace, real or fake. |
| `mode` | `'local'` (default) or `'time-skipping'`. |
| `searchAttributes` | Extra search attributes to register, in addition to the ones the workflows declare. |
| `taskQueues` | Poll a subset of the workflows' queues. |
| `worker` | `false` to skip the worker, for example to test starts and signals only. |
| `dataConverter`, `clientDataConverter` | Custom data converters for the worker and the client. |
| `serverPath`, `logLevel` | See above. |

The environment has `client`, `workflow(WorkflowClass)` (shorthand for `client.workflow()`), `worker`, `temporal` (the SDK's `TestWorkflowEnvironment`), `mode`, `sleep()` and `teardown()`.

## Activity tests

An activity class is a plain class, so test it with a fake dependency and no Temporal at all:

```ts
it('charges with the order ID as the idempotency key', async () => {
  const gateway = { charge: vi.fn(async () => ({ id: 'ch_1', cents: 500 })), refund: vi.fn() };
  await new PaymentActivities(gateway).charge('o-1', 500);
  expect(gateway.charge).toHaveBeenCalledWith({ orderId: 'o-1', cents: 500, idempotencyKey: 'charge-o-1' });
});
```

For activities that call `heartbeat()` or read `Context.current()`, run them inside the SDK's `MockActivityEnvironment` from `@temporalio/testing`.

## Replay tests

Before you change a workflow that has executions in flight, check the new code replays their histories. Download a history with `temporal workflow show --workflow-id <id> --output json > history.json`, then use the SDK's replayer with a Norn bundle:

```ts
import { Worker } from '@temporalio/worker';
import { bundleWorkflows } from '@norn-ts/norn/worker';

const bundle = await bundleWorkflows(new URL('../src/workflows/index.ts', import.meta.url));
await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(await readFile('history.json', 'utf8')));
```
