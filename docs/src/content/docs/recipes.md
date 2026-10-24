---
title: "Recipes"
description: An HTTP API, schedules, payload encryption and tracing, with the client and Temporal's own APIs.
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
