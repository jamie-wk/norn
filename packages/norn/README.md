# @norn-ts/norn

Write [Temporal](https://temporal.io) workflows and activities as plain, typed TypeScript classes.

```sh
pnpm create @norn-ts my-app
```

```ts
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Signal, Workflow, useActivities } from '@norn-ts/norn/workflow';
import type { PaymentActivities } from '../activities/payment.activities';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private canceled = false;
  private payments = useActivities<PaymentActivities>('payments', { timeout: '30s', retries: 3 });

  @Signal() cancel() {
    this.canceled = true;
  }

  async run(input: { orderId: string; cents: number }) {
    const charge = await this.payments.charge(input.orderId, input.cents);
    if (await condition(() => this.canceled, '5 minutes')) await this.payments.refund(charge.id);
  }
}
```

```ts
// src/worker.ts
import { createWorker } from '@norn-ts/norn/worker';

const worker = await createWorker({
  workflows: new URL('./workflows/index.ts', import.meta.url),
  activities: { payments: new PaymentActivities(gateway) },
});
await worker.run();
```

```ts
// anywhere
import { createClient } from '@norn-ts/norn/client';

const orders = createClient().workflow(OrderWorkflow);
const order = await orders.start({ orderId: 'o-1', cents: 1999 });
await order.signal('cancel');
```

| Import | What |
| --- | --- |
| `@norn-ts/norn/workflow` | `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate`, `useActivities()`, `useChild()`, `continueAsNew()`, … Safe in the workflow sandbox. |
| `@norn-ts/norn/worker` | `createWorker()`, `bundleWorkflows()` |
| `@norn-ts/norn/client` | `createClient()`: typed starts, signals, queries and updates, with Norn errors |
| `@norn-ts/norn/testing`, `/vitest`, `/vite` | `createTestEnv()`, `useTestEnv()`, `standardDecorators()` |
| `@norn-ts/norn` | Error types and shared option types |

Docs: https://jamie-wk.github.io/norn/ · MIT
