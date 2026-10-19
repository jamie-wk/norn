# Continue-as-new & long-running workflows

Temporal workflows can run for months or years, but each **run** accumulates an event history, and histories have limits (Temporal warns at 10,240 events and terminates runs at 51,200 events or 50 MB). Long-lived workflows, such as one per customer, per subscription or per device, periodically **continue as new**: the current run completes and a fresh run of the same workflow ID starts with a new input and an empty history.

## `continueAsNew()`

```ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, continueAsNew, continueAsNewSuggested } from '@norn-ts/workflow';

export interface LoyaltyInput {
  customerId: string;
  points?: number;
  /** Recently credited orders, carried across runs so redelivered signals never double-credit. */
  recent?: string[];
  maxEventsPerRun?: number;
}

/** One workflow per customer, accumulating points forever. */
@Workflow({ taskQueue: 'loyalty', id: 'loyalty-{customerId}' })
export class LoyaltyWorkflow {
  private points: number;
  private readonly recent: string[];
  private eventsThisRun = 0;

  constructor(input: LoyaltyInput) {
    // State for this run comes from the input: either the first start, or the previous run.
    this.points = input.points ?? 0;
    this.recent = [...(input.recent ?? [])];
  }

  @Signal() orderCompleted(event: { orderId: string; cents: number }) {
    if (this.recent.includes(event.orderId)) return;
    this.recent.push(event.orderId);
    if (this.recent.length > 200) this.recent.shift();
    this.points += Math.floor(event.cents / 100);
    this.eventsThisRun++;
  }

  @Query() balance() {
    return { points: this.points };
  }

  async run(input: LoyaltyInput): Promise<never> {
    const max = input.maxEventsPerRun ?? 500;
    await condition(() => this.eventsThisRun >= max || continueAsNewSuggested());
    return continueAsNew<LoyaltyInput>(() => ({ customerId: input.customerId, points: this.points, recent: this.recent, maxEventsPerRun: max }));
  }
}
```

Three things to notice:

1. **The constructor reads state from the input.** The first run gets `{ customerId }`; every later run gets the previous run's carried state. Handlers see the right state from the first event of each run.
2. **`continueAsNew()` waits for in-flight handlers first**, so a signal or update that is mid-flight isn't lost in the rollover. Pass the input as a function, as above, so it's read *after* those handlers finish; a plain object is captured before they do. Pass `{ waitForHandlers: false }` to skip the wait.
3. **`continueAsNew()` never returns**; `return` it so TypeScript knows the method ends there. A workflow that only ever continues as new returns `Promise<never>`.

`continueAsNewSuggested()` is `true` when Temporal recommends rolling over because history is getting large. Checking both it and your own counter keeps runs small and predictable.

Clients don't need to care: a handle from `get({ customerId })` without a run ID always targets the latest run, so signals and queries keep working across rollovers.

## What to carry across

Everything you need must be in the next run's input, because the new run starts from scratch:

- **Business state**: balances, the current status, counters.
- **Deduplication keys**: [`dedupeBy`](/guide/messages#dedupeby-at-least-once-sources) only remembers keys within one run. Carry a bounded list of recent keys, as `recent` does above.
- **State machines**: `transitions()` accepts a snapshot as its initial state:

  ```ts
  constructor(input: SubscriptionInput) {
    // a state name or a snapshot
    this.status = transitions(TABLE, input.status ?? 'trialing');
  }
  // ...
  return continueAsNew(() => ({ ...input, status: this.status.snapshot() }));
  ```

Search attributes and memo carry over automatically. The correlation ID is forwarded to the next run by Norn's workflow interceptor.

## Patterns for long-running workflows

**Entity workflows.** One workflow per business entity (customer, account, subscription) with an ID template on the entity's key. Signals and updates mutate it; queries read it; it continues as new on a size budget. Start it lazily with `signalWithStart` or `updateWithStart` from the client, so callers don't have to know whether it exists yet.

**Periodic work.** A loop of `await sleep('1 day')` plus work, continuing as new every N iterations. For wall-clock schedules ("every weekday at 9:00 in Chicago"), prefer a [schedule](/guide/schedules), which starts a fresh short workflow each time.

**Waiting for a long time.** A timer that fires in 90 days costs nothing while it waits. You don't need to continue as new just because a workflow is old; you need to when history grows.

**Batch fan-out.** Instead of one run scheduling 100,000 activities, have the parent start children over batches, or process a page per run and continue as new with a cursor.

## Changing long-running workflows

Long-running workflows are the ones most likely to be running when you deploy a change. Continue-as-new is also a safe point to upgrade: a new run starts on the new code. See [Versioning & safe deploys](/guide/versioning) for pinned workflows, patching and replay tests.
