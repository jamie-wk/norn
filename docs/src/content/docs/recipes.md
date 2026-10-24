---
title: "Recipes"
description: An HTTP API, a monorepo, schedules, payload encryption and tracing, with the client and Temporal's own APIs.
---

Norn keeps to workflows, activities, the worker and the client. These recipes cover common needs with a few lines of your own code and the Temporal SDK.

## An HTTP API

Create one client per process and map Norn's errors to responses. With [Hono](https://hono.dev):

```ts
import { Hono } from 'hono';
import { createClient } from '@norn-ts/norn/client';
import { NornError } from '@norn-ts/norn';
import { OrderWorkflow } from './workflows/order.workflow';

const norn = createClient();
const app = new Hono();

app.post('/orders', async (c) => {
  const { orderId, cents } = await c.req.json<{ orderId: string; cents: number }>();
  const order = await norn.workflow(OrderWorkflow).start({ orderId, cents });
  return c.json({ workflowId: order.workflowId }, 201);
});

app.get('/orders/:orderId', async (c) => {
  const order = norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') });
  return c.json({ status: await order.query('getStatus') });
});

app.onError((error, c) => {
  if (error instanceof NornError && error.status < 500) return c.json({ error: error.toJSON() }, error.status as 400);
  console.error(error);
  return c.json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } }, 500);
});
```

Validate request bodies before starting a workflow: a missing ID field throws `NornConfigError`, which is a 500.

For webhooks, verify the signature, then turn the event into a signal. Webhooks arrive at least once, so deduplicate with `@Signal({ dedupeBy: (e) => e.id })`.

## A monorepo

A common split: the workflows in a shared package, a worker service that owns the activities, and an API that starts workflows.

```
packages/workflows/   # @acme/workflows: the @Workflow classes, exported from src/index.ts
apps/worker/          # activities, services and the worker
apps/api/             # the HTTP API, which only uses the client
```

The worker points at the workflows package, re-exported from a file of its own so the production build below can compile it:

```ts
// apps/worker/src/workflows.ts
export * from '@acme/workflows';
```

```ts
// apps/worker/src/worker.ts
const worker = await createWorker({
  workflows: new URL('./workflows.ts', import.meta.url),
  activities: { pricing: new PricingActivities(db) },
});
```

The API imports the workflow classes and calls `createClient().workflow(QuoteWorkflow)`, as in [An HTTP API](#an-http-api). Workflows import activity classes with `import type`, so neither the API nor the workflow sandbox gets activity code.

- **Each package declares what it imports.** The worker bundles the workflows with the `node_modules` closest to them, and pnpm only links declared dependencies, so `@acme/workflows` needs `@norn-ts/norn` and `@temporalio/workflow` (otherwise bundling fails with `Can't resolve '@temporalio/workflow/...'`). The API needs `@norn-ts/norn`, `@temporalio/client`, `@temporalio/workflow` and `@acme/workflows`.
- **The API's build must run standard decorators**, because it imports the workflow classes: tsx, esbuild with `--target=node22`, or `tsc` with `target` ES2022 or later. Node's type stripping can't, and a framework set to `experimentalDecorators` compiles them the legacy way, which breaks them.
- **Activity types reach the API's type check.** Keep activity method signatures to plain data, so the API doesn't need your services' SDKs installed to compile.
- **Production:** compile the workflows package into the worker's build by keeping workspace packages out of `--packages=external`:

  ```sh
  esbuild src/worker.ts src/workflows.ts --bundle --platform=node --target=node22 --format=esm \
    '--external:@norn-ts/*' '--external:@temporalio/*' --outdir=dist
  ```

  `node dist/worker.js` then loads `dist/workflows.js`, as in the [starter](/norn/guides/worker/#production).
- `workflows` also takes the string `import.meta.resolve()` returns. If your workspace packages resolve to source through a custom export condition, set `NORN_DEV_CONDITIONS` so the workflow bundler uses it too.

To run the activities in a different service from the workflows, give that service an activity-only worker, `createWorker({ activities, taskQueues: ['pricing'] })`, and point the calls at its queue: `useActivities<PricingActivities>('pricing', { taskQueue: 'pricing' })`. Share the activity types through a package both import.

## Schedules

Create schedules with the Temporal client, for example in a deploy script:

```ts
import { createClient } from '@norn-ts/norn/client';

const norn = createClient();
await norn.temporal.schedule.create({
  scheduleId: 'daily-report',
  spec: { cronExpressions: ['0 6 * * *'], timezone: 'Europe/Berlin' },
  action: { type: 'startWorkflow', workflowType: 'DailyReportWorkflow', taskQueue: 'reports', args: [{}] },
});
```

## Payload encryption

Temporal encrypts payloads with a `PayloadCodec` in the data converter. Pass the same data converter to `createWorker({ dataConverter })` and `createClient({ dataConverter })`. Temporal's [encryption sample](https://github.com/temporalio/samples-typescript/tree/main/encryption) has a complete AES-GCM codec, and Temporal's docs cover running a codec server for the Web UI.

## Tracing and metrics

Use Temporal's OpenTelemetry plugin and pass it to `createWorker({ plugins })`. For Prometheus metrics, install the SDK runtime before creating the worker, as shown in [Worker](/norn/guides/worker/#metrics-logs-and-health).
