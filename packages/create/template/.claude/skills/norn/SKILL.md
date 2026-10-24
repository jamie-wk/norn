---
name: norn
description: How to build durable workflows with Norn, a thin layer of typed decorators on the Temporal TypeScript SDK (the @norn-ts/norn package). Use this whenever the code imports @norn-ts/norn or one of its subpaths (/workflow, /worker, /client, /testing, /vitest, /vite), or the user wants to add or change a workflow, activity, signal, query, update, child workflow, worker, Temporal client call or workflow test in a Norn project, even if they only say "Temporal" or "workflow".
---

# Building with Norn

Norn puts typed decorators on top of Temporal's TypeScript SDK. Workflows are decorated classes, activities are plain classes, and the client is typed from the workflow class. There is no code generation. Docs: https://jamie-wk.github.io/norn/ (all of it: https://jamie-wk.github.io/norn/llms-full.txt).

## The mental model: three places code runs

| Code | Runs in | May import |
| --- | --- | --- |
| `@Workflow` classes (`src/workflows/`) | Temporal's deterministic sandbox, replayed from history | `@norn-ts/norn/workflow`, `@norn-ts/norn`, `@temporalio/workflow`, `@temporalio/common`, other workflow files, pure helpers, and `import type` of anything. **No** Node APIs, I/O, `process.env`, `setTimeout`, or value imports of activity or service code. |
| Activity classes (`src/activities/`) and what they use (`src/services/`) | The worker process, normal Node | Anything. This is where all I/O lives. |
| The worker (`src/worker.ts`), API code, scripts | Normal Node | `@norn-ts/norn/worker`, `@norn-ts/norn/client`, and workflow classes (importing a workflow class is fine: it carries only decorators and types) |

Most mistakes come from crossing these lines, so check imports first when something breaks.

## How the pieces connect

- `src/workflows/index.ts` exports every `@Workflow` class. The worker gets it as `workflows: new URL('./workflows/index.ts', import.meta.url)`.
- The worker gets activities by namespace: `activities: { payments: new PaymentActivities(gateway) }` registers every method as `payments.<method>`.
- A workflow calls them with `useActivities<PaymentActivities>('payments', options)`, importing the class with `import type`. The namespace string must match the worker's key.
- Clients pass the workflow class: `norn.workflow(OrderWorkflow)`.

When you add a workflow, export it from `src/workflows/index.ts`. When you add an activity class, register it in `src/worker.ts` and in the test environment.

## Recipes

**A workflow** with signals, queries and validated updates:

```ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, useActivities } from '@norn-ts/norn/workflow';
import type { PaymentActivities } from '../activities/payment.activities';

// id fields are checked against run()'s input
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: 'open' | 'paid' | 'canceled' = 'open';
  private readonly pay = useActivities<PaymentActivities>('payments', {
    timeout: '30s',
    retries: 3, // retries AFTER the first attempt
    nonRetryable: ['CardDeclinedError'], // error names
    methods: { refund: { retries: 10 } },
  });

  // providers redeliver
  @Signal({ dedupeBy: (e: { eventId: string }) => e.eventId })
  paymentEvent(_e: { eventId: string }) {}

  @Query() getStatus() { return this.status; }

  @Validate('cancel') checkCancel() { if (this.status !== 'open') throw new Error(`Order is ${this.status}`); }
  @Update() cancel() { this.status = 'canceled'; return this.status; }

  async run(input: { orderId: string; cents: number }) {
    if (await condition(() => this.status === 'canceled', '1 hour')) return this.status;
    await this.pay.charge(input.orderId, input.cents);
    this.status = 'paid';
    return this.status;
  }
}
```

Handlers are registered before `run()` starts, and signals that arrived before the first workflow task are applied then, so set up state in the constructor (it gets the same input as `run()`). By default the workflow waits for in-flight async handlers before completing (`drainHandlers`).

**Activities** are plain classes; build their dependencies with constructors in `src/worker.ts`:

```ts
// explicit name survives minification; nonRetryable matches on it
export class CardDeclinedError extends Error { override name = 'CardDeclinedError'; }

export class PaymentActivities {
  constructor(private readonly gateway: PaymentGateway) {}

  async charge(orderId: string, cents: number) {
    // activities can retry: make them idempotent
    return this.gateway.charge({ orderId, cents, idempotencyKey: `charge-${orderId}` });
  }
}
```

Heartbeats, cancellation and `ApplicationFailure` come from `@temporalio/activity` and `@temporalio/common`, as in the plain SDK. Match a failure in a workflow with `asFailure(error, 'CardDeclinedError')`.

**Children, external workflows, long-running entities:** `useChild(ChildWorkflow)` then `.execute(input)` / `.start(input)`; `useExternal(Workflow, { idFields })` to signal another workflow. For entities that live forever, roll over with `return continueAsNew(() => ({ ...nextInput }))`; pass a **function** so the input is read after in-flight handlers finish. Check `continueAsNewSuggested()` alongside your own event counter.

**Calling workflows** from an API or a script:

```ts
import { createClient } from '@norn-ts/norn/client';
import { OrderWorkflow } from './workflows/order.workflow';

// TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
const norn = createClient();
const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 1999 });
// get() makes no call
await norn.workflow(OrderWorkflow).get({ orderId: 'o-1' }).update('cancel');
```

Handler names are method names. Types can't tell a signal method from a query method, so using one as the wrong kind compiles and throws `NornConfigError` when called. Errors are `NornError`s with HTTP statuses: `WorkflowAlreadyStartedError` 409, `WorkflowNotFoundError` 404, `WorkflowClosedError` 409, `UpdateRejectedError` 422 (a validator or the update threw; `failureType` is the error name), `TemporalUnavailableError` 503.

**The worker:** `const worker = await createWorker({ workflows, activities }); await worker.run();` It drains on SIGTERM. For production, `pnpm build` (esbuild) then `pnpm start`; optionally prebuild the workflow bundle with `bundleWorkflows()` and set `NORN_WORKFLOW_BUNDLE`.

## Testing

```ts
// vitest.config.ts needs: plugins: [standardDecorators()] from '@norn-ts/norn/vite'
import { expect, it, vi } from 'vitest';
import { useTestEnv } from '@norn-ts/norn/vitest';
import { OrderWorkflow } from '../src/workflows/order.workflow';

const payments = { charge: vi.fn(async (orderId: string) => ({ id: `ch_${orderId}` })) };
// timers skip instantly
const env = useTestEnv({ workflows: new URL('../src/workflows/index.ts', import.meta.url), activities: { payments }, mode: 'time-skipping' });

it('charges after the window', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500 });
  expect(await order.result()).toBe('paid');
  expect(payments.charge).toHaveBeenCalledWith('o-1', 500);
});
```

`useTestEnv` starts one server and worker per test file (`beforeAll`/`afterAll`), so fake calls accumulate across tests: assert on calls for each test's own IDs. A handler called after the workflow has finished fails with `WorkflowClosedError`, not `UpdateRejectedError`. Use `mode: 'local'` (a real dev server) for search attributes and `list()` queries. Unit-test activity classes directly with fake dependencies. Write the failing test first and cover the sad paths (declines, cancels, timeouts, rejected updates).

## Gotchas

- TC39 **standard** decorators only: `target` ES2022+, never `experimentalDecorators`. Node's type stripping can't run decorators: use `tsx` in development, esbuild with `--target=node22` for builds, and `standardDecorators()` in Vitest.
- Running executions depend on names: workflow types, task queues, handler names and activity names (`<namespace>.<method>`). Renaming one breaks them.
- Changing workflow logic that in-flight executions have already passed through breaks replay. Gate changes with `patched()` from `@temporalio/workflow`, or use worker versioning; run replay tests before deploying.
- Pass inputs as one serializable object; keep payloads small (store large data elsewhere and pass IDs).
- Search attributes are declared on `@Workflow({ searchAttributes })` and set with `setSearchAttributes()`; create them on the server first (`temporal operator search-attribute create`).
- Don't loosen types to make something compile: IDs, handler args/results and activity signatures are checked on purpose.
