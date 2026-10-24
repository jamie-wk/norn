# @norn-ts/hono

[Hono](https://hono.dev) integration for [Norn](https://jamie-wk.github.io/norn/): a middleware that puts a typed Temporal client and a correlation ID on every request, an error handler that turns Norn errors into JSON responses, a webhook handler that routes events to signals and updates, and a Temporal codec server.

## Install

```sh
pnpm add @norn-ts/hono @norn-ts/client hono @temporalio/client @temporalio/common
```

## Example

```ts
import { Hono } from 'hono';
import { nornErrorHandler, temporal, type NornEnv } from '@norn-ts/hono';
import { Orders } from './.norn/contracts';

const app = new Hono<NornEnv>();
app.use(temporal({ address: process.env.TEMPORAL_ADDRESS }));
app.onError(nornErrorHandler());

app.post('/orders', async (c) => {
  // 409 JSON if it is already running
  const handle = await c.var.norn.workflow(Orders).start(await c.req.json());
  return c.json({ workflowId: handle.workflowId }, 201);
});

export default app;
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/hono/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
