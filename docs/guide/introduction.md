# Introduction

Norn is an open-source (MIT) framework for writing [Temporal](https://temporal.io) workflows in TypeScript. It sits on top of the official Temporal TypeScript SDK (1.24) and keeps everything that makes Temporal good: durable execution, the deterministic workflow sandbox, retries, timers, signals, updates and worker versioning. What it changes is how your code is organised and how much of it you have to write by hand.

With Norn you write **workflows as decorated classes**, **activities as decorated classes with injected services**, and you run **`norn gen`** to generate the glue: a workflow barrel for the bundler, workflow-safe activity references, typed contracts for API code, dependency-injection wiring and a worker registry. Then `createWorker()` runs everything with production defaults, and `createClient()` gives your API typed handles.

## A taste

```ts
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn/workflow';
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
import { Activities, Activity, NonRetryable } from '@norn/activity';
import { CardDeclinedError } from '../errors.js';
import { PaymentGateway } from '../services/payment-gateway.js';

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
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
// api: anywhere, e.g. a Hono route
import { createClient } from '@norn/client';
import { OrderWorkflow } from '../.norn/contracts.js';

const norn = createClient();
// ID: order-o-42
const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-42', cents: 1999 });
// typed: signal names and arguments are checked
await order.signal('cancel', 'changed my mind');
// 'pending' | 'paid' | 'refunded'
const status = await order.query('getStatus');
```

## Why Norn

The Temporal TypeScript SDK is deliberately low level. That is a strength, but most applications end up rebuilding the same layer on top of it:

- **Names as strings in two places.** Workflows are registered by export name, activities by object key, signals and queries by the string you pass to `defineSignal()`. API code repeats those strings (or imports workflow modules just to get the definitions). Norn derives every name from your classes and generates contracts, so a typo is a compile error.
- **Types that stop at the process boundary.** The API usually knows nothing about a workflow's input, result or handler arguments unless you import the workflow file, which drags workflow code (and anything it imports) into your API bundle. Norn's contracts use `import type` only.
- **The sandbox boundary.** Workflow code must not import activity code, Node built-ins or most npm packages. In the plain SDK you learn this at bundle time or, worse, on replay. Norn generates type-only activity references for workflows, and `norn gen` and the ESLint plugin check the import boundary and determinism rules while you type.
- **Activity dependencies.** Real activities need database pools, HTTP clients and SDK clients, created once and disposed on shutdown, some per execution. Norn has a small, compile-time dependency container built for exactly this.
- **Production plumbing.** Health endpoints, SIGTERM draining, worker versioning, Prometheus metrics, correlation IDs, error mapping to HTTP statuses, payload encryption, replay tests. Every team writes these; Norn ships them.

Norn does not hide Temporal. Every wrapper exposes the underlying SDK object (`handle.temporal`, `client.temporal`, `workerOptions`, `plugins`), and inside workflows you still import `sleep`, `condition`, `patched` and friends from `@temporalio/workflow`. If you know Temporal, you already know most of Norn. If you don't, the [Temporal docs](https://docs.temporal.io) remain the best place to learn the concepts; these docs focus on how Norn expresses them.

## Why the name Norn

In Norse myth, the three Norns, **Urðr**, **Verðandi** and **Skuld**, sit at the well beneath Yggdrasil and weave the threads of fate: *what has been*, *what is becoming*, and *what shall be*.

A Temporal workflow is woven from the same three threads. Its **event history** is what has been: every decision, recorded and replayable. The **running workflow** is what is becoming: code reacting to signals and updates as they arrive. Its **timers and schedules** are what shall be: the reminder in three days, the settlement window, the nightly report.

Norn weaves those threads into code that reads like the story it tells: a class whose `run()` method is the plot, whose decorated methods are the interruptions, and whose timers are the promises it keeps.

## What's in the box

| Package | What it does |
| --- | --- |
| [`@norn/core`](https://github.com/jamie-wk/norn/tree/main/packages/core#readme) | Workflow-safe building blocks: contracts, durations, ID templates, errors, state machines, business-day calendars. |
| [`@norn/workflow`](https://github.com/jamie-wk/norn/tree/main/packages/workflow#readme) | `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate`, `@Schedule`; `useActivities`, `useChild`, `useExternal`, `continueAsNew`. |
| [`@norn/activity`](https://github.com/jamie-wk/norn/tree/main/packages/activity#readme) | `@Activities`, `@Activity`, `@NonRetryable`, `@Service`, tokens, `provide()`, the container, activity context helpers. |
| [`@norn/client`](https://github.com/jamie-wk/norn/tree/main/packages/client#readme) | `createClient()`: typed start, execute, signal, query, update, with-start operations, list and count. |
| [`@norn/worker`](https://github.com/jamie-wk/norn/tree/main/packages/worker#readme) | `createWorker()`: one worker per task queue, health checks, graceful drain, versioning, bundling, metrics. |
| [`@norn/testing`](https://github.com/jamie-wk/norn/tree/main/packages/testing#readme) | `createTestEnv()`, typed `mockActivities()`, `createFakeClient()`, replay checks, the Vitest decorator plugin. |
| [`@norn/codec`](https://github.com/jamie-wk/norn/tree/main/packages/codec#readme) | AES-256-GCM payload encryption with key rotation; a payload converter for `bigint` and TC39 Temporal values. |
| [`@norn/hono`](https://github.com/jamie-wk/norn/tree/main/packages/hono#readme) | Hono middleware with correlation IDs, an error handler, webhook-to-signal routing and a codec server. |
| [`@norn/cli`](https://github.com/jamie-wk/norn/tree/main/packages/cli#readme) | `norn gen`, `norn bundle`, `norn schedules sync`, `norn histories pull`. |
| [`@norn/eslint-plugin`](https://github.com/jamie-wk/norn/tree/main/packages/eslint-plugin#readme) | Editor-time determinism and import-boundary rules for workflow files. |

## Requirements

- **Node.js 22.18 or later** (tested on 22, 24 and 26).
- **A Temporal service**: Temporal Cloud, a self-hosted cluster or `temporal server start-dev` locally.
- **TypeScript 5.0+ or 7** with **TC39 standard decorators**. Do **not** enable `experimentalDecorators`: Norn's decorators are standard decorators, and the legacy ones have a different signature. See [Getting started](/guide/getting-started#typescript) for the tsconfig.

Next: [Getting started](/guide/getting-started).
