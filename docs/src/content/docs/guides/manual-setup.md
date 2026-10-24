---
title: "Getting started"
---

This walkthrough builds a small order service from an empty directory: a workflow, an activity class with an injected service, a worker, an HTTP endpoint that starts the workflow, and a test. It takes about fifteen minutes.

## Prerequisites

- **Node.js 22.18+** and a package manager (the examples use pnpm).
- **A Temporal server.** For local development, install the [Temporal CLI](https://docs.temporal.io/cli) and run:

  ```sh
  temporal server start-dev
  ```

  This starts a server on `localhost:7233` and the Web UI on `http://localhost:8233`. Norn connects to `localhost:7233` by default.

## 1. Create the project

```sh
mkdir acme-orders && cd acme-orders
pnpm init
pnpm pkg set type=module
```

Install Norn and the Temporal SDK packages it builds on (they are peer dependencies, so your app controls the SDK version):

```sh
pnpm add @norn-ts/core @norn-ts/workflow @norn-ts/activity @norn-ts/worker @norn-ts/client \
  @temporalio/workflow @temporalio/activity @temporalio/worker @temporalio/client @temporalio/common
pnpm add -D @norn-ts/cli @norn-ts/testing @norn-ts/eslint-plugin @temporalio/testing \
  typescript vitest esbuild @types/node
```

For the HTTP part of this guide, also add Hono:

```sh
pnpm add @norn-ts/hono hono @hono/node-server
```

## 2. TypeScript

Norn uses **TC39 standard decorators**, which TypeScript supports since 5.0 without any flag. Two settings matter:

- `target` must be **ES2022 or later** (class fields and standard decorator semantics).
- **Do not** set `experimentalDecorators` (or `emitDecoratorMetadata`). Legacy decorators have a different signature and Norn's decorators will not work with them.

```json
// tsconfig.json: type-checks everything, emits nothing
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "ESNext.Disposable"],
    "types": ["node"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "useDefineForClassFields": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", ".norn", "test", "norn.config.ts", "vitest.config.ts"]
}
```

```json
// tsconfig.build.json: compiles the app to dist/
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": ".", "outDir": "dist" },
  "include": ["src", ".norn"]
}
```

`verbatimModuleSyntax` is recommended: Norn relies on `import type` to keep activity code out of the workflow sandbox and worker code out of your API, and this flag makes TypeScript keep your imports exactly as written. `ESNext.Disposable` gives you the types for `await using`, which Norn's workers, clients and test environments support.

:::tip[Running TypeScript directly]
Node's built-in type stripping does not support decorators, because they are not erasable syntax. Compile with `tsc` (as below), or use a runner that lowers standard decorators, such as one based on esbuild. Workflow code is different: the worker bundles it with its own compiler settings, so it can stay TypeScript in development.
:::

## 3. Configure `norn gen`

`norn gen` scans your sources for decorated classes and writes the generated files to `.norn/`. Create `norn.config.ts` at the project root:

```ts
// norn.config.ts
import { defineConfig } from '@norn-ts/cli';

export default defineConfig({
  include: ['src/**/*.ts'],
});
```

The defaults are `include: ['src/**/*.ts']`, `outDir: '.norn'` and `.js` extensions in generated imports. Later you will add `providers: 'src/providers.ts'` for configuration and SDK clients (see [Dependency injection](/norn/guides/dependency-injection/#providers-configuration-and-sdk-clients)); [The norn CLI](/norn/reference/cli/) lists every option.

## 4. A service behind an interface

Activities talk to the outside world through services. Declare the interface, and a **token** with the same name, so the container can inject it by type:

```ts
// src/services/payment-gateway.ts
import { Service, token } from '@norn-ts/activity';

export interface Charge {
  id: string;
  cents: number;
}

export class CardDeclinedError extends Error {
  override name = 'CardDeclinedError';
}

export interface PaymentGateway {
  charge(request: { orderId: string; cents: number; idempotencyKey: string }): Promise<Charge>;
  refund(chargeId: string): Promise<boolean>;
}
export const PaymentGateway = token<PaymentGateway>('PaymentGateway');

/** A stand-in gateway; swap it for a real provider later. */
@Service({ provides: PaymentGateway })
export class FakePaymentGateway implements PaymentGateway {
  async charge(request: { orderId: string; cents: number; idempotencyKey: string }): Promise<Charge> {
    if (request.cents <= 0) throw new CardDeclinedError('amount must be positive');
    return { id: `ch_${request.orderId}`, cents: request.cents };
  }
  async refund(_chargeId: string) {
    return true;
  }
}
```

Error classes set `name` explicitly (to the class name). Norn records an error's `name` as its failure type, and an explicit name survives minification.

## 5. Activities

```ts
// src/activities/payment.activities.ts
import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { CardDeclinedError, PaymentGateway } from '../services/payment-gateway.js';

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  constructor(private readonly gateway: PaymentGateway) {}

  /** The order ID is the idempotency key, so a retried attempt never charges twice. */
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

There is no `inject: [...]` here: `norn gen` reads the constructor's parameter type, `PaymentGateway`, finds the token with the same name, and writes the wiring. `retries: 3` means up to three retries after the first attempt.

## 6. The workflow

```ts
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn-ts/workflow';
import { PaymentActivities } from '../../.norn/activities.js';

export interface OrderInput {
  orderId: string;
  cents: number;
}

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

  async run(input: OrderInput) {
    const charge = await this.pay.charge(input.orderId, input.cents);
    this.status = 'paid';
    // Wait up to an hour for a cancellation; condition() returns false on timeout.
    if (await condition(() => this.canceled, '1 hour')) {
      await this.pay.refund(charge.id);
      this.status = 'refunded';
    }
    return this.status;
  }
}
```

Note the import: the workflow uses `PaymentActivities` from **`.norn/activities.js`**, not from `src/activities/`. That generated file holds a workflow-safe reference (names and options, with the class imported as a type only), so the workflow bundle never contains activity code. The `id` template is checked against `run()`'s input at compile time: `'order-{orderId}'` compiles because `OrderInput` has an `orderId`.

## 7. Generate

```sh
pnpm norn gen
```

```text
wrote .norn/workflows.ts
wrote .norn/activities.ts
wrote .norn/contracts.ts
wrote .norn/container.ts
wrote .norn/registry.ts
wrote .norn/schedules.json
wrote .norn/search-attributes.json
wrote norn.lock.json
```

Commit `.norn/` and `norn.lock.json`; CI runs `norn gen --check` to make sure they are up to date. [Project layout & codegen](/norn/guides/project-layout/) explains each file. Add `norn gen` to your scripts so it runs before builds and tests:

```json
{
  "scripts": {
    "gen": "norn gen",
    "build": "norn gen && tsc -p tsconfig.build.json",
    "worker": "node dist/src/worker.js",
    "api": "node dist/src/api.js",
    "test": "norn gen && vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

## 8. The worker

```ts
// src/worker.ts
import { createWorker } from '@norn-ts/worker';
import { registry } from '../.norn/registry.js';

const worker = await createWorker({ registry });
// until SIGTERM / SIGINT, then drains gracefully
await worker.run();
```

`createWorker()` connects to `TEMPORAL_ADDRESS` (default `localhost:7233`), builds the activities through the container, bundles the workflows, and polls every task queue in the registry. Build and run it:

```sh
pnpm build
pnpm worker
```

## 9. Start workflows from an API

With Hono:

```ts
// src/api.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { nornErrorHandler, temporal, type NornEnv } from '@norn-ts/hono';
import { OrderWorkflow } from '../.norn/contracts.js';

const app = new Hono<NornEnv>();
// a Norn client on c.var.norn, plus correlation IDs
app.use(temporal({}));
// NornErrors become JSON responses with the right status
app.onError(nornErrorHandler());

app.post('/orders', async (c) => {
  const input = await c.req.json<{ orderId: string; cents: number }>();
  const order = await c.var.norn.workflow(OrderWorkflow).start(input);
  return c.json({ workflowId: order.workflowId }, 201);
});

app.post('/orders/:orderId/cancel', async (c) => {
  await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).signal('cancel', 'customer request');
  return c.body(null, 204);
});

app.get('/orders/:orderId', async (c) => {
  const status = await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).query('getStatus');
  return c.json({ status });
});

serve({ fetch: app.fetch, port: 3000 });
```

Starting the same order twice returns **409** (`WORKFLOW_ALREADY_STARTED`), asking about an unknown order returns **404**, and Temporal being down returns **503**, all via `nornErrorHandler()`. Nothing in this file imports worker code: `.norn/contracts.ts` imports the workflow class with `import type`.

Without Hono, use the client directly in any framework:

```ts
import { createClient } from '@norn-ts/client';
import { OrderWorkflow } from '../.norn/contracts.js';

// TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
const norn = createClient();
const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 1999 });
// 'paid' after an hour, or 'refunded'
console.log(await order.result());
```

## 10. Test it

Vite (and so Vitest) compiles TypeScript with Oxc, which leaves standard decorators in place, and Node cannot run them. `@norn-ts/testing/vite` provides a plugin that lowers them first:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { standardDecorators } from '@norn-ts/testing/vite';

export default defineConfig({
  plugins: [standardDecorators()],
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
```

```ts
// test/order.workflow.test.ts
import { expect, it } from 'vitest';
import { mockActivities, useTestEnv } from '@norn-ts/testing/vitest';
import { PaymentActivities } from '../.norn/activities.js';
import { OrderWorkflow } from '../.norn/contracts.js';
import { registry } from '../.norn/registry.js';

const pay = mockActivities(PaymentActivities, {
  charge: async (orderId, cents) => ({ id: `ch_${orderId}`, cents }),
  refund: async () => true,
});

// One time-skipping Temporal server and worker for this file.
const env = useTestEnv({ registry, mode: 'time-skipping', activities: pay });

it('keeps the charge when nobody cancels', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500 });
  // the 1 hour timer is skipped
  expect(await order.result()).toBe('paid');
  expect(pay.refund).not.toHaveBeenCalled();
});

it('refunds when canceled', async () => {
  const order = await env.workflow(OrderWorkflow).start({ orderId: 'o-2', cents: 500 });
  await order.signal('cancel', 'test');
  expect(await order.result()).toBe('refunded');
  expect(pay.refund).toHaveBeenCalledWith('ch_o-2');
});
```

The first run downloads Temporal's test server; later runs reuse it. See [Testing](/norn/guides/testing/) for the dev-server mode, the fake client for API unit tests, and replay tests.

## Your project now

```text
acme-orders/
├── .norn/                     # generated by norn gen; committed
│   ├── activities.ts          # workflow-safe activity references
│   ├── container.ts           # dependency-injection wiring
│   ├── contracts.ts           # typed contracts for API code
│   ├── registry.ts            # what createWorker() runs
│   ├── workflows.ts           # the bundle entry point
│   ├── schedules.json
│   └── search-attributes.json
├── src/
│   ├── activities/payment.activities.ts
│   ├── services/payment-gateway.ts
│   ├── workflows/order.workflow.ts
│   ├── worker.ts
│   └── api.ts
├── test/order.workflow.test.ts
├── norn.config.ts
├── norn.lock.json             # rename protection; committed
├── tsconfig.json
├── tsconfig.build.json
└── vitest.config.ts
```

## Next steps

- [Project layout & codegen](/norn/guides/project-layout/): what each generated file is for, and how to split worker and API into separate packages.
- [Workflows](/norn/guides/workflows/) and [Signals, queries & updates](/norn/guides/messages/).
- [Worker & deployment](/norn/guides/worker/): production bundles, Docker, health checks and environment variables.
- Add the [ESLint rules](/norn/guides/eslint/) to catch sandbox mistakes in your editor.
