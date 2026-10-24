---
title: Quickstart
---

```ts twoslash
import { Workflow } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  async run(input: { orderId: string; cents: number }) {
    return input.cents;
    //           ^?
  }
}
```

```ts twoslash
// @errors: 1270
import { Workflow } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'orders', id: 'order-{orderID}' })
export class OrderWorkflow {
  async run(input: { orderId: string }) {}
}
```
