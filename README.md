# Norn

Typed, decorator-driven [Temporal](https://temporal.io) workflows for TypeScript.

Norn is an open-source framework on top of the official Temporal TypeScript SDK (1.24). It keeps everything Temporal gives you (durable execution, the deterministic workflow sandbox, retries, timers, signals, updates, worker versioning) and changes how much of it you write by hand: workflows and activities are decorated classes, `norn gen` generates the glue, `createWorker()` runs it with production defaults, and `createClient()` gives API code typed handles.

**Documentation:** https://jamie-wk.github.io/norn/

## Before and after

The same order workflow, with the raw SDK:

```ts
// workflows.ts
import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './activities.js';

export const cancelSignal = defineSignal<[reason: string]>('cancel');
export const statusQuery = defineQuery<string>('getStatus');

const { charge, refund } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 4, nonRetryableErrorTypes: ['CardDeclinedError'] },
});

export async function orderWorkflow(input: { orderId: string; cents: number }): Promise<string> {
  let status = 'pending';
  let canceled = false;
  setHandler(cancelSignal, () => void (canceled = true));
  setHandler(statusQuery, () => status);

  const ch = await charge(input.orderId, input.cents);
  status = 'paid';
  if (await condition(() => canceled, '1 hour')) {
    await refund(ch.id);
    status = 'refunded';
  }
  return status;
}

// api.ts: the type name, task queue and ID format are repeated by hand,
// and signalling means importing the workflow module into the API.
const handle = await client.workflow.start('orderWorkflow', {
  taskQueue: 'orders',
  workflowId: `order-${orderId}`,
  args: [{ orderId, cents }],
});
await handle.signal(cancelSignal, 'changed my mind');
```

With Norn:

```ts
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn-ts/workflow';
// generated, workflow-safe
import { PaymentActivities } from '../../.norn/activities.js';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: 'pending' | 'paid' | 'refunded' = 'pending';
  private canceled = false;
  private readonly pay = useActivities(PaymentActivities);

  @Signal() cancel(_reason: string) {
    this.canceled = true;
  }

  @Query() getStatus() {
    return this.status;
  }

  async run(input: { orderId: string; cents: number }) {
    const charge = await this.pay.charge(input.orderId, input.cents);
    this.status = 'paid';
    if (await condition(() => this.canceled, '1 hour')) {
      await this.pay.refund(charge.id);
      this.status = 'refunded';
    }
    return this.status;
  }
}
```

```ts
// src/activities/payment.activities.ts
import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { CardDeclinedError, PaymentGateway } from '../services/payment-gateway.js';

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  // injected
  constructor(private readonly gateway: PaymentGateway) {}

  @Activity({ timeout: '30s', retries: 3 })
  @NonRetryable([CardDeclinedError])
  async charge(orderId: string, cents: number) {
    return this.gateway.charge({ orderId, cents, idempotencyKey: `charge-${orderId}` });
  }

  @Activity({ timeout: '30s', retries: 10 })
  async refund(chargeId: string) {
    return this.gateway.refund(chargeId);
  }
}
```

```ts
// api.ts: no worker code imported, every name and argument type-checked
// ID order-o-42
const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-42', cents: 1999 });
await order.signal('cancel', 'changed my mind');
// 'pending' | 'paid' | 'refunded'
const status = await order.query('getStatus');
```

## Features

- **Workflows as classes**: `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate` and `@Schedule`, using TC39 standard decorators. Handlers are registered before they can fire, and in-flight handlers are drained before completion and continue-as-new.
- **Types end to end**: workflow IDs from templates checked against the input, handler names and arguments, update results, search attributes and activity signatures are all checked at compile time, from the API to the activity.
- **Code generation without running your code**: `norn gen` parses your source with oxc and writes workflow-safe activity references, typed contracts for API code (`import type` only), the workflow bundle entry, dependency-injection wiring and a worker registry. It also checks the sandbox import boundary and determinism rules, and keeps a lock file so renames can't strand running executions.
- **Dependency injection for activities**: services, interface tokens and providers, singleton and per-execution scopes, ordered disposal, cycle and captive-dependency checks. No `reflect-metadata`.
- **Errors you can branch on**: activity errors become failures typed by class name (`asFailure(error, PaymentDeclinedError)`), and client errors have stable codes and HTTP statuses (409, 404, 422, 503).
- **Production workers**: one worker per task queue, health endpoints, graceful SIGTERM drain, worker versioning, prebuilt bundles, Prometheus metrics and correlation IDs from HTTP request to activity.
- **Testing**: time-skipping workflow tests with typed activity mocks, an in-memory fake client for API tests, and replay tests against recorded histories.
- **Extras**: AES-256-GCM payload encryption with key rotation, Hono middleware with webhook-to-signal routing and a codec server, and ESLint rules for workflow code.

Norn never hides Temporal: every wrapper exposes the SDK object underneath (`handle.temporal`, `client.temporal`, `workerOptions`, `plugins`), and workflows still import `sleep`, `condition` and `patched` from `@temporalio/workflow`.

## Install

```sh
pnpm add @norn-ts/core @norn-ts/workflow @norn-ts/activity @norn-ts/worker @norn-ts/client \
  @temporalio/workflow @temporalio/activity @temporalio/worker @temporalio/client @temporalio/common
pnpm add -D @norn-ts/cli @norn-ts/testing @norn-ts/eslint-plugin @temporalio/testing typescript vitest esbuild
```

The Temporal SDK packages are peer dependencies, so your app controls the SDK version.

## Quick start

1. **TypeScript**: set `target` to ES2022 or later and do **not** set `experimentalDecorators` or `emitDecoratorMetadata`. `verbatimModuleSyntax` is recommended, since Norn relies on `import type` to keep activity code out of workflows and worker code out of your API.

2. **Configure `norn gen`**:

   ```ts
   // norn.config.ts
   import { defineConfig } from '@norn-ts/cli';

   export default defineConfig({ include: ['src/**/*.ts'] });
   ```

   Add `providers: 'src/providers.ts'` once you register configuration or SDK clients with `provide()`.

3. **Write** a workflow, an activity class and its services (as above), then **generate**:

   ```sh
   pnpm norn gen   # writes .norn/ and norn.lock.json; commit both, run `norn gen --check` in CI
   ```

4. **Run a worker** (with a local server from `temporal server start-dev`):

   ```ts
   // src/worker.ts
   import { createWorker } from '@norn-ts/worker';
   import { registry } from '../.norn/registry.js';

   // TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
   const worker = await createWorker({ registry });
   // until SIGTERM, then drains gracefully
   await worker.run();
   ```

5. **Start workflows** from any API:

   ```ts
   import { createClient } from '@norn-ts/client';
   import { OrderWorkflow } from '../.norn/contracts.js';

   const norn = createClient();
   const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 1999 });
   ```

6. **Test it** with `createTestEnv()` from `@norn-ts/testing` and the `standardDecorators()` Vite plugin from `@norn-ts/testing/vite`.

The [Getting started guide](https://jamie-wk.github.io/norn/guide/getting-started) walks through all of this from an empty directory, and [`examples/orders`](./examples/orders) is a complete app: worker, generated contracts, a Hono API and tests.

## Packages

| Package | Description |
| --- | --- |
| [`@norn-ts/core`](./packages/core) | Workflow-safe building blocks: contracts, durations, ID templates, errors with codes and HTTP statuses, `transitions()`, business-day calendars. Zero runtime dependencies. |
| [`@norn-ts/workflow`](./packages/workflow) | `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate`, `@Schedule`, `useActivities()`, `useChild()`, `useExternal()`, `continueAsNew()`, `asFailure()`, `setSearchAttributes()`. |
| [`@norn-ts/activity`](./packages/activity) | `@Activities`, `@Activity`, `@NonRetryable`, `@Service`, tokens, `provide()`, the dependency container, error mapping and activity context helpers. |
| [`@norn-ts/client`](./packages/client) | `createClient()`: typed start, execute, signal, query, update, with-start operations, list and count, with Norn error mapping and correlation IDs. |
| [`@norn-ts/worker`](./packages/worker) | `createWorker()`: one worker per task queue, bundling, health checks, graceful drain, worker versioning and Prometheus metrics. |
| [`@norn-ts/testing`](./packages/testing) | `createTestEnv()`, typed `mockActivities()`, `createFakeClient()`, `assertReplays()`, Vitest helpers and the standard-decorators Vite plugin. |
| [`@norn-ts/cli`](./packages/cli) | `norn gen` (syntax-only codegen and checks), `norn schedules sync`, `norn histories pull`, `norn bundle`. |
| [`@norn-ts/codec`](./packages/codec) | AES-256-GCM payload encryption with key rotation, and a payload converter for `bigint` and TC39 Temporal values. |
| [`@norn-ts/hono`](./packages/hono) | Hono middleware with a typed client and correlation IDs, an error handler, webhook-to-signal routing and a codec server. |
| [`@norn-ts/eslint-plugin`](./packages/eslint-plugin) | `norn/workflow-determinism` and `norn/no-activity-imports` for editor-time checks of workflow code. |

## Using Norn with coding agents

[`skills/norn/SKILL.md`](skills/norn/SKILL.md) is an [agent skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) that teaches coding agents Norn's conventions: what may run in the workflow sandbox, when to run `norn gen`, and how to write workflows, activities and tests. For Claude Code, copy the `skills/norn` folder into your project's `.claude/skills/`. The docs site also serves [`llms.txt`](https://jamie-wk.github.io/norn/llms.txt).

## Why the name Norn

In Norse myth, the three Norns, **Urðr**, **Verðandi** and **Skuld**, sit at the well beneath Yggdrasil and weave the threads of fate: what has been, what is becoming, and what shall be.

A Temporal workflow is woven from the same three threads. Its **event history** is what has been: every decision, recorded and replayable. The **running workflow** is what is becoming: code reacting to signals and updates as they arrive. Its **timers and schedules** are what shall be: the reminder in three days, the settlement window, the nightly report.

## Requirements

- **Node.js 22.18 or later** (tested on 22, 24 and 26).
- **Temporal TypeScript SDK 1.24** (`@temporalio/*` `^1.24.0`) and a Temporal service: Temporal Cloud, a self-hosted cluster, or `temporal server start-dev` locally.
- **TypeScript with TC39 standard decorators.** Never enable `experimentalDecorators`: Norn's decorators are standard decorators, and the legacy ones have a different signature.

## Links

- Documentation: https://jamie-wk.github.io/norn/
- Source and issues: https://github.com/jamie-wk/norn
- Changelogs: each package's `CHANGELOG.md`, and GitHub releases

## Contributing

Contributions are welcome. Open an issue first for anything larger than a small fix, so we can agree on the approach.

The repository is a pnpm workspace (pnpm 10, Node 22.18+):

```sh
pnpm install
pnpm build                 # all packages
pnpm lint                  # oxlint --deny-warnings
pnpm typecheck
pnpm test                  # unit tests
pnpm test:integration      # against a real Temporal dev server and the time-skipping test server
pnpm check:deps && pnpm check:pack
pnpm docs:dev              # the documentation site
```

Integration tests download Temporal's binaries unless `NORN_TEMPORAL_CLI_PATH` / `NORN_TEMPORAL_TEST_SERVER_PATH` point at existing ones (put them in a gitignored `.env.test.local`; on a Mac, `brew install temporal`).

Ground rules:

- Write the failing test first, and cover both the happy and the sad paths.
- TC39 standard decorators only; never `experimentalDecorators`.
- Keep type safety end to end; don't loosen types to make something compile.
- `@norn-ts/core` has zero runtime dependencies, and nothing that runs in the workflow sandbox imports Node APIs (`pnpm check:deps` enforces this).
- Use pnpm, not npm or yarn. Add a changeset (`pnpm changeset`) for user-facing changes.

## License

[MIT](./LICENSE) © Jamie King
