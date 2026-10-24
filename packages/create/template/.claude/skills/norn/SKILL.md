---
name: norn
description: How to build durable workflows with Norn, the decorator-driven TypeScript framework on the Temporal TypeScript SDK (@norn-ts/* packages). Use this whenever the code imports @norn-ts/core, @norn-ts/workflow, @norn-ts/activity, @norn-ts/worker, @norn-ts/client, @norn-ts/testing, @norn-ts/hono, @norn-ts/codec or @norn-ts/cli, has a norn.config.ts or a .norn/ directory, or the user wants to add or change a workflow, activity, signal, query, update, schedule, child workflow, worker, Temporal client call, webhook or workflow test in a Norn project, even if they only say "Temporal" or "workflow".
---

# Building with Norn

Norn puts typed decorators and code generation on top of Temporal's TypeScript SDK. You write classes; `norn gen` writes the wiring into `.norn/`; Temporal runs it durably. Docs: https://jamie-wk.github.io/norn/ (each package README on GitHub, `jamie-wk/norn`, lists its full API).

## The mental model: three places code runs

| Code | Runs in | May import |
| --- | --- | --- |
| `@Workflow` classes (`src/workflows/*.workflow.ts`) | Temporal's deterministic sandbox, replayed from history | `@norn-ts/workflow`, `@norn-ts/core`, `@temporalio/workflow`, `.norn/activities`, other workflow files, pure helpers. **No** Node APIs, I/O, `Date.now()`, `Math.random()`, activity or service classes. |
| `@Activities` classes and `@Service`s (`src/activities`, `src/services`) | The worker process, normal Node | Anything. This is where all I/O lives. |
| API / other services | Anywhere | `@norn-ts/client` or `@norn-ts/hono` plus `.norn/contracts` (type-only references to workflows) |

Most mistakes come from crossing these lines, so check imports first when something breaks.

## The generated `.norn/` directory

Run `norn gen` after adding or changing any decorated class, its handlers, an activity signature or an injected constructor. Commit everything it writes: `.norn/`, `norn.lock.json`, and the `contracts.outFile` if `norn.config.ts` sets one. CI runs `norn gen --check`. Generated imports use `importExtension` from `norn.config.ts` (`'.js'` default, or `'.ts'`); import `.norn/*` files with the same extension the project already uses (the snippets below use `.js`).

- `.norn/activities.ts`: workflow-safe activity references. **Workflows import activities from here**, never from `src/activities` (that would pull Node code into the bundle).
- `.norn/contracts.ts`: typed contracts for clients, `import type` only, so API code never bundles worker code.
- `.norn/registry.ts`: what `createWorker({ registry })` runs. `.norn/container.ts`: DI wiring. `.norn/workflows.ts`: the bundle entry; export names must equal workflow type names, so don't hand-edit it.
- `norn.lock.json` blocks renaming workflow types, handlers, activities and task queues (in-flight executions still use the old names). Rename deliberately with `norn gen --accept-rename`.

## Recipes

**A workflow** with signals, queries and validated updates:

```ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, useActivities } from '@norn-ts/workflow';
import { PaymentActivities } from '../../.norn/activities.js';

// id fields are checked against run()'s input
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: 'open' | 'paid' | 'canceled' = 'open';
  private readonly pay = useActivities(PaymentActivities);

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

Handlers are registered before `run()` starts, and signals that arrived before the first workflow task are applied then, so read baselines from the input, not from fields at the top of `run()`. By default the workflow waits for in-flight async handlers before completing (`drainHandlers`).

**Activities and services** (dependency injection by constructor type):

```ts
import { Activities, Activity, NonRetryable, Service, token } from '@norn-ts/activity';

export interface PaymentGateway { charge(r: { orderId: string; cents: number; idempotencyKey: string }): Promise<{ id: string }> }
// same name as the interface
export const PaymentGateway = token<PaymentGateway>('PaymentGateway');

@Service({ provides: PaymentGateway })
export class StripeGateway implements PaymentGateway { /* ... */ }

// explicit name survives minification
export class CardDeclinedError extends Error { override name = 'CardDeclinedError'; }

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  // norn gen resolves the token by type name
  constructor(private readonly gateway: PaymentGateway) {}

  // retries AFTER the first attempt
  @Activity({ timeout: '30s', retries: 3 })
  @NonRetryable([CardDeclinedError])
  async charge(orderId: string, cents: number) {
    // activities can retry: make them idempotent
    return this.gateway.charge({ orderId, cents, idempotencyKey: `charge-${orderId}` });
  }
}
```

Match a typed failure in a workflow with `asFailure(error, CardDeclinedError)`. Configuration and SDK clients go in a providers module (`providers: 'src/providers.ts'` in `norn.config.ts`).

**Children, external workflows, long-running entities:** `useChild(ChildWorkflow)` then `.execute(input)` / `.start(input)`; `useExternal(Workflow)` to signal another workflow. For entities that live forever, roll over with `return continueAsNew(() => ({ ...nextInput }))`; pass a **function** so the input is read after in-flight handlers finish (a plain object is captured before, losing their effects). Check `continueAsNewSuggested()` alongside your own event counter.

**Calling workflows** from an API or another service:

```ts
import { createClient } from '@norn-ts/client';
import { OrderWorkflow } from '../.norn/contracts.js';

// TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
const norn = createClient();
const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 1999 });
// get() makes no call
await norn.workflow(OrderWorkflow).get({ orderId: 'o-1' }).update('cancel');
```

Errors are typed `NornError`s from `@norn-ts/core` with HTTP statuses: `WorkflowAlreadyStartedError` 409, `WorkflowNotFoundError` 404, `WorkflowClosedError` 409, `UpdateRejectedError` 422 (a validator or the update threw), `TemporalUnavailableError` 503. With Hono, `app.use(temporal({}))` puts the client on `c.var.norn` and `app.onError(nornErrorHandler())` turns those into JSON responses. `temporalWebhook({ verify, map })` maps provider webhooks to signals (`verify` is required; use `hmacSha256Verifier`). `codecServer({ codec, auth })` requires `auth`.

**The worker:** `const worker = await createWorker({ registry }); await worker.run();` It drains on SIGTERM; health endpoints on `NORN_HEALTH_PORT`; production uses a prebuilt bundle (`norn bundle` → `NORN_WORKFLOW_BUNDLE`).

**Schedules:** `@Schedule(...)` on a workflow, then `norn schedules sync` (`--dry-run` first; deleting needs `--prune`).

## Testing

```ts
// vitest.config.ts needs: plugins: [standardDecorators()] from '@norn-ts/testing/vite'
import { mockActivities, useTestEnv } from '@norn-ts/testing/vitest';
import { PaymentActivities } from '../.norn/activities.js';
import { OrderWorkflow } from '../.norn/contracts.js';
import { registry } from '../.norn/registry.js';

const pay = mockActivities(PaymentActivities, { charge: async (orderId) => ({ id: `ch_${orderId}` }) });
// timers skip instantly
const env = useTestEnv({ registry, mode: 'time-skipping', activities: pay });

it('charges after the window', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500 });
  expect(await order.result()).toBe('paid');
  expect(pay.charge).toHaveBeenCalledWith('o-1', 500);
});
```

`useTestEnv` starts one server, worker and set of mocks per test file (`beforeAll`/`afterAll`), so mock calls accumulate across tests: assert on calls for each test's own IDs. A handler called after the workflow has finished fails with `WorkflowClosedError`, not `UpdateRejectedError`; to test "rejected once X happened" when X also ends the workflow, hold the final activity mock on a promise until the assertion is done. Use `mode: 'local'` (a real dev server) for search attributes and `list()` queries. `createFakeClient()` unit-tests API code without a server; `assertReplays()` catches non-deterministic changes against recorded histories (`norn histories pull`). Write the failing test first and cover the sad paths (declines, cancels, timeouts, rejected updates).

## Gotchas

- TC39 **standard** decorators only: `target` ES2022+, never `experimentalDecorators`. Node's type stripping can't run decorators: compile with `tsc`, and use `standardDecorators()` in Vitest.
- Changing workflow logic that in-flight executions have already passed through breaks replay. Gate changes with `patched()` from `@temporalio/workflow`, or use worker versioning; run replay tests before deploying.
- Pass inputs as one serializable object; keep payloads small (store large data elsewhere and pass IDs).
- Search attributes are declared on `@Workflow({ searchAttributes })` and set with `setSearchAttributes()`; register them on the server (`norn gen` writes `.norn/search-attributes.json`).
- Don't loosen types to make something compile: IDs, handler args/results and activity signatures are checked end to end on purpose.

The ESLint plugin (`@norn-ts/eslint-plugin`, `configs.recommended`) flags non-determinism and activity imports in workflow files while you type.
