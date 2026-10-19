# Child & external workflows

A workflow can start other workflows as **children**, and signal or cancel workflows it didn't start (**external** workflows). Both are typed the same way as the client: inputs, results and signal arguments come from the target's class or contract.

## Child workflows: `useChild()`

```ts
// src/workflows/shipment.workflow.ts
import { Workflow } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'shipping', id: 'shipment-{orderId}' })
export class ShipmentWorkflow {
  async run(input: { orderId: string }) {
    // ...
    return { trackingNumber: `TRK-${input.orderId}` };
  }
}
```

```ts
// src/workflows/order.workflow.ts
import { Workflow, useChild } from '@norn-ts/workflow';
import { ShipmentWorkflow } from './shipment.workflow.js';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private readonly shipment = useChild(ShipmentWorkflow);

  async run(input: { orderId: string }) {
    // Starts shipment-{orderId} on the 'shipping' queue and waits for its result.
    const { trackingNumber } = await this.shipment.execute({ orderId: input.orderId });
    return trackingNumber;
  }
}
```

`useChild(target, defaults?)` returns a reference with two methods:

- `execute(input, options?)` starts the child and resolves with its result.
- `start(input, options?)` resolves once the child is running, with a handle: `workflowId`, `firstExecutionRunId`, `result()` and `signal(method, ...args)`.

```ts
const child = await this.shipment.start({ orderId: input.orderId });
// if ShipmentWorkflow has @Signal() expedite(level: number)
await child.signal('expedite', 2);
const result = await child.result();
```

The child's workflow ID comes from its `id` template and the input, unless you pass `workflowId`. Its task queue is the child's own `taskQueue`, so a child on another queue runs on whichever workers poll that queue.

### Options

Pass defaults to `useChild()`, and per-call options to `start()` / `execute()`:

| Option | Description |
| --- | --- |
| `workflowId` | Explicit ID. Required when the child has no ID template. |
| `parentClosePolicy` | What happens to the child when the parent closes: `'terminate'` (default), `'abandon'` or `'request-cancel'`. |
| `taskQueue` | Override the child's task queue. |
| `executionTimeout`, `runTimeout`, `taskTimeout` | Child workflow timeouts, as `Duration`s. |
| `memo` | Memo for the child execution. |

```ts
// A report that should keep running even if the parent finishes first.
private readonly report = useChild(MonthlyReportWorkflow, { parentClosePolicy: 'abandon' });
```

### Classes or contracts

A class target must be a workflow in the **same bundle**: it is imported into the parent's workflow file, which is fine because it is workflow code too. For a workflow implemented somewhere else (another service, another repository, another language), pass a **contract** instead. A contract carries the name, task queue, ID template and handler names, with no code:

```ts
import { defineWorkflow, signal, type } from '@norn-ts/core';

export const KycCheck = defineWorkflow({
  name: 'KycCheck',
  taskQueue: 'compliance',
  id: 'kyc-{companyId}',
  input: type<{ companyId: string; country: string }>(),
  output: type<{ approved: boolean; reason?: string }>(),
  signals: { documentsUploaded: signal<[documentIds: string[]]>() },
});

// in a workflow
private readonly kyc = useChild(KycCheck);
const { approved } = await this.kyc.execute({ companyId: input.companyId, country: 'US' });
```

With a contract target, signal names are the contract's keys.

### Children vs activities

Use a child workflow when the sub-process is long-running, has its own timers or messages, should be visible and queryable as its own execution, or runs on another team's workers. Use an activity for a single side effect. Children also partition history: a parent that would otherwise accumulate thousands of events can delegate batches to children.

## External workflows: `useExternal()`

`useExternal(target, id)` returns a handle to a workflow the current one did not start, for signals and cancellation. Pass the target's ID template fields, or `{ workflowId, runId? }`:

```ts
import { useExternal } from '@norn-ts/workflow';
import { LoyaltyWorkflow } from './loyalty.workflow.js';

// from inside a workflow
await useExternal(LoyaltyWorkflow, { customerId: input.customerId }).signal('orderCompleted', { orderId, cents });
await useExternal(OrderWorkflow, { workflowId: 'order-o-42' }).cancel();
```

The handle has `workflowId`, `signal(method, ...args)` and `cancel()`. Signals sent this way carry the current correlation ID, like everything else the workflow sends.

To *start* a workflow if it isn't running and then signal it (signal-with-start), use the client from an [activity](/guide/activities#activities-that-call-temporal); workflow code cannot signal-with-start.
