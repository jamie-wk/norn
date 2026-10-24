---
title: Durable execution in 5 minutes
description: What Temporal gives you, the words you will meet, and how replay lets a workflow survive a crash.
---

Temporal runs your code **durably**. A workflow is ordinary async TypeScript, but its progress is recorded on a server as it goes. If the process running it dies, another process carries on from the same point. Everything on this page is Temporal's behavior; Norn changes how you write it down.

## What Temporal gives you

- **Workflows that survive crashes.** A workflow can run for seconds or months. Restarts and deploys don't lose its place.
- **Retries.** Steps that talk to the outside world (activities) are retried with backoff.
- **Durable timers.** `sleep('3 days')` is a timer kept by the server, not by your process.
- **History and replay.** Every step is appended to the workflow's **event history**, which is how it comes back after a crash.

## The vocabulary

| Temporal term | What it is | In Norn |
| --- | --- | --- |
| Temporal server | Stores histories, keeps timers, hands out work. The starter's `pnpm dev` runs one locally. | `TEMPORAL_ADDRESS`, default `localhost:7233` |
| Web UI | Every workflow and its history, in a browser. | `http://localhost:8233` locally |
| Workflow | Deterministic code that decides what happens next. | A class with `@Workflow`; its `run()` method is the main line |
| Workflow ID | The unique name of one execution, such as `order-o-42`. | The `id: 'order-{orderId}'` template |
| Activity | One step that does I/O, such as an HTTP call. Retried by Temporal. | `@Activity` methods on an `@Activities` class, called through `useActivities()` |
| Worker | Your process. It polls the server and runs workflows and activities. | `createWorker({ workflows, activities })` |
| Task queue | A named queue linking work to the workers that can do it. | `@Workflow({ taskQueue: 'orders' })` |
| Signal | A message into a running workflow, with no reply. | `@Signal()` |
| Query | A read of a workflow's state. It changes nothing. | `@Query()` |
| Update | A message that can change state and returns a result. | `@Update()`, optionally with `@Validate` |
| Timer | A durable wait. | `sleep()` and `condition()` from `@temporalio/workflow` |
| Client | Code that starts workflows and sends them messages. | `createClient()`, then `norn.workflow(OrderWorkflow)` |

## The starter's order workflow

`pnpm create @norn-ts` gives you this workflow in `src/workflows/order.workflow.ts`, shortened here:

```ts
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: OrderStatus = 'pending';
  private canceled = false;
  private readonly payments = useActivities<PaymentActivities>('payments', { timeout: '30s', retries: 3 });

  @Signal() cancel(_reason: string) {
    this.canceled = true;
  }

  @Query() getStatus(): OrderStatus {
    return this.status;
  }

  async run(input: OrderInput): Promise<OrderStatus> {
    const charge = await this.payments.charge(input.orderId, input.cents);
    this.status = 'paid';
    if (await condition(() => this.canceled, '5 minutes')) {
      await this.payments.refund(charge.id);
      this.status = 'refunded';
    }
    return this.status;
  }
}
```

It charges the order, then waits up to 5 minutes for a `cancel` signal. `condition()` returns `true` if `canceled` becomes true in time, and `false` when the timeout runs out.

When you run `pnpm order start o-1` and then `pnpm order cancel o-1`, the server records this history (simplified; the real one has a few more bookkeeping events):

```text
 client     Temporal server: history of order-o-1                 worker
 ──────     ─────────────────────────────────────                 ──────
 start ──►  1 WorkflowExecutionStarted   {orderId:'o-1',…} ───► run() begins
            2 ActivityTaskScheduled      payments.charge   ◄─── charge(...)
            3 ActivityTaskCompleted      {id:'ch_o-1',…}   ◄─── the activity ran
            4 TimerStarted               5 minutes         ◄─── condition(...)
 cancel ──► 5 WorkflowExecutionSignaled  cancel            ───► cancel() runs
            6 ActivityTaskScheduled      payments.refund   ◄─── refund(...)
            7 ActivityTaskCompleted      true              ◄─── the activity ran
            8 WorkflowExecutionCompleted 'refunded'        ◄─── run() returns
```

The worker never tells the server which line it is on. It sends **commands** (schedule this activity, start this timer), and the server records events.

## What happens when the worker crashes mid-wait

Say the worker dies after event 4, two minutes into the wait. The `OrderWorkflow` instance, `status` and the `charge` variable are gone. Nothing that matters is lost:

- The timer lives on the server and keeps counting.
- A `cancel` sent now is still accepted: the server appends event 5 and queues a task on `orders` for the next worker that polls.

When a worker comes back, it picks up that task. It has no copy of the workflow in memory, so it **replays** it:

1. It constructs `OrderWorkflow` with the input from event 1 and calls `run()` from the top.
2. `run()` calls `charge(...)`. The SDK finds events 2 and 3 in the history, so instead of running the activity again it returns the recorded result, `{ id: 'ch_o-1', cents: 1999 }`. The card is not charged twice.
3. `status` becomes `'paid'`. `condition(...)` matches the timer from event 4.
4. The history then delivers event 5, so `cancel()` runs and `canceled` becomes `true`.
5. Replay has reached the end of the history. From here on the code runs live: `condition()` returns `true`, and the worker sends a new command to schedule `payments.refund`.

If no signal arrives, the server records `TimerFired` after 5 minutes, worker or no worker, and the workflow completes with `'paid'` once a worker picks it up.

Try it with the starter, whose local server keeps its data in `.temporal/`: start an order with `pnpm order`, stop `pnpm dev` with Ctrl+C, start it again within 5 minutes, and run `pnpm order cancel <id>`. The order is refunded, and its history in the Web UI has a single `payments.charge`.

If the worker dies while `charge` is running, that attempt times out (`timeout: '30s'`) and Temporal retries it. That is why the starter gives the gateway an idempotency key.

## The catch: replay must take the same path

Replay only works if `run()` makes the same decisions every time it runs over the same history. If the code read the real clock, or was changed to call a different activity first, the replayed commands would not match the recorded events, and Temporal stops with a non-determinism error rather than guess.

That rule is the subject of the next page, [Determinism & the sandbox](/norn/concepts/determinism/). Changing workflow code that is already running is covered at the end of that page.
