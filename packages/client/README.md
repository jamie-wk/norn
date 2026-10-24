# @norn-ts/client

A typed Temporal client for [Norn](https://jamie-wk.github.io/norn/). Give it a contract from `.norn/contracts.ts` and every start, signal, query and update is checked at compile time; Temporal errors come back as Norn errors with stable codes and HTTP statuses.

## Install

```sh
pnpm add @norn-ts/client @temporalio/client @temporalio/common
```

## Example

```ts
import { createClient } from '@norn-ts/client';
import { OrderWorkflow } from './.norn/contracts.js';

// reads TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
await using norn = createClient();

const order = await norn.workflow(OrderWorkflow).start({ orderId: 'o-42', cents: 1999 });
await order.signal('cancel', 'changed my mind');
console.log(await order.result());
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/client/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
