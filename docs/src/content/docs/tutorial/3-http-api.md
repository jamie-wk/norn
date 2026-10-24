---
title: 3. Add an HTTP API
description: Put the order workflow behind a Hono API with typed handles and Norn errors mapped to HTTP statuses, and test the routes without a Temporal server.
sidebar:
  order: 3
---

Real orders don't come from a script. In this chapter you'll put the workflow behind an HTTP API built with [Hono](https://hono.dev), using `@norn-ts/hono` for the Temporal plumbing.

```sh
pnpm add @norn-ts/hono hono @hono/node-server
```

## The app

```ts
// src/api.ts
import { Hono } from 'hono';
import { nornErrorHandler, temporal, type NornEnv } from '@norn-ts/hono';
import type { NornClient } from '@norn-ts/client';
import { OrderWorkflow } from '../.norn/contracts';
import type { OrderInput } from './workflows/order.workflow';
import type { Address } from './services/shipping';

/** The HTTP API. Tests pass a fake client; in production it creates one from TEMPORAL_ADDRESS. */
export function buildApp(client?: NornClient) {
  const app = new Hono<NornEnv>();
  // A Norn client on c.var.norn, and a correlation ID for every request.
  app.use(temporal(client ? { client } : {}));
  // Norn errors become JSON responses with the right status: 409, 404, 422, 503...
  app.onError(nornErrorHandler());

  app.post('/orders', async (c) => {
    const input = await c.req.json<OrderInput>();
    const order = await c.var.norn.workflow(OrderWorkflow).start(input);
    return c.json({ workflowId: order.workflowId }, 201);
  });

  app.get('/orders/:orderId', async (c) => {
    const status = await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).query('getStatus');
    return c.json({ status });
  });

  app.post('/orders/:orderId/cancel', async (c) => {
    await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).signal('cancel', 'customer request');
    return c.body(null, 202);
  });

  app.put('/orders/:orderId/address', async (c) => {
    const address = await c.req.json<Address>();
    const updated = await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).update('changeAddress', address);
    return c.json(updated);
  });

  return app;
}
```

```ts
// src/server.ts
import { serve } from '@hono/node-server';
import { buildApp } from './api';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: buildApp().fetch, port });
console.log(`API listening on http://localhost:${port}`);
```

The imports are worth a closer look. The API imports `OrderWorkflow` from **`.norn/contracts`**, and `OrderInput` and `Address` with `import type`. None of these pull workflow or activity code into the API at runtime: the contract imports the workflow class as a type only. Every route is still fully typed. `get({ orderId })` builds the workflow ID from the class's `id: 'order-{orderId}'` template, and `update('changeAddress', address)` checks the argument against the update's signature. [Contracts & the client/worker split](/norn/concepts/contracts/) explains how.

:::caution[Validate request bodies]
`c.req.json<OrderInput>()` trusts the client to send the right shape. That keeps the tutorial short, but a real API should validate the body first, for example with Zod and `@hono/zod-validator`.
:::

## Run it

Add a script to `package.json`:

```json
"api": "tsx watch src/server.ts"
```

With `pnpm dev` still running, start the API in a second terminal (set `PORT` if 3000 is taken), and try it from a third:

```sh
pnpm api
```

```sh
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"orderId":"o-100","cents":1999,"address":{"name":"Ada","street":"1 Main St","city":"London","country":"GB"}}'
# {"workflowId":"order-o-100"}  201

curl -X POST localhost:3000/orders -H 'content-type: application/json' -d '...the same body...'
# {"error":{"code":"WORKFLOW_ALREADY_STARTED","message":"Workflow order-o-100 is already running",...}}  409

curl -X PUT localhost:3000/orders/o-100/address -H 'content-type: application/json' \
  -d '{"name":"Ada","street":"","city":"Leeds","country":"GB"}'
# {"error":{"code":"UPDATE_REJECTED","message":"The address is incomplete",...}}  422

curl -X POST localhost:3000/orders/o-100/cancel
# 202

curl localhost:3000/orders/o-100
# {"status":"refunded"}  200

curl localhost:3000/orders/nope
# {"error":{"code":"WORKFLOW_NOT_FOUND","message":"Workflow order-nope was not found",...}}  404
```

You didn't write any error handling. Starting a workflow whose ID is already running throws `WorkflowAlreadyStartedError`, an unknown order throws `WorkflowNotFoundError`, and a validator's rejection throws `UpdateRejectedError`. Each is a `NornError` with a code and an HTTP status, and `nornErrorHandler()` turns it into a JSON response. Every response also carries an `x-correlation-id` header, which follows the request into the workflow and its activities' logs. See [Observability](/norn/guides/observability/#correlation-ids).

The workflow ID doubles as an **idempotency key**. A client that retries `POST /orders` after a timeout gets a 409 instead of a second charge.

## Test the routes without Temporal

API tests don't need a Temporal server. `createFakeClient()` is an in-memory client that follows the same rules (ID templates, duplicate starts, unknown workflows) and throws the same errors:

```ts
// test/api.test.ts
import { expect, it } from 'vitest';
import { createFakeClient } from '@norn-ts/testing';
import { UpdateRejectedError } from '@norn-ts/client';
import { OrderWorkflow } from '../.norn/contracts';
import { buildApp } from '../src/api';

const address = { name: 'Ada', street: '1 Main St', city: 'Springfield', country: 'US' };
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

it('starts an order, and refuses to start it twice', async () => {
  const fake = createFakeClient();
  const app = buildApp(fake);

  const first = await app.request('/orders', post({ orderId: 'o-1', cents: 500, address }));
  expect(first.status).toBe(201);
  expect(await first.json()).toEqual({ workflowId: 'order-o-1' });
  expect(fake.started(OrderWorkflow)).toEqual([{ orderId: 'o-1', cents: 500, address }]);

  const again = await app.request('/orders', post({ orderId: 'o-1', cents: 500, address }));
  expect(again.status).toBe(409);
});

it('returns 404 for an order that does not exist', async () => {
  const res = await buildApp(createFakeClient()).request('/orders/nope');
  expect(res.status).toBe(404);
});

it('returns 422 when the workflow rejects an address change', async () => {
  const fake = createFakeClient();
  fake.stub(OrderWorkflow, {
    updates: {
      changeAddress: () => {
        throw new UpdateRejectedError({ workflowId: 'order-o-1', update: 'changeAddress', failureType: 'OrderLockedError', message: 'The order is already shipping' });
      },
    },
  });
  await fake.workflow(OrderWorkflow).start({ orderId: 'o-1', cents: 500, address });

  const res = await buildApp(fake).request('/orders/o-1/address', { ...post(address), method: 'PUT' });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ error: { code: 'UPDATE_REJECTED' } });
});
```

```sh
pnpm test
```

```text
 Test Files  2 passed (2)
      Tests  9 passed (9)
```

The workflow tests check what the workflow does; these check what the API does with it. Neither depends on the other, and the API tests run in milliseconds.

Next: [change workflows safely](/norn/tutorial/4-safe-changes/).
