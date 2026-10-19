import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, continueAsNew, continueAsNewSuggested } from '@norn/workflow';

export interface LoyaltyInput {
  customerId: string;
  points?: number;
  /** Recently credited orders, carried across runs so retries never double-credit. */
  recent?: string[];
  /** Continue as new after this many credits (keeps history small). */
  maxEventsPerRun?: number;
}

/** One long-running workflow per customer that accumulates points forever. */
@Workflow({ taskQueue: 'orders', id: 'loyalty-{customerId}' })
export class LoyaltyWorkflow {
  private points: number;
  private readonly recent: string[];
  private eventsThisRun = 0;

  constructor(input: LoyaltyInput) {
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
    return { points: this.points, orders: this.recent.length };
  }

  async run(input: LoyaltyInput): Promise<never> {
    const max = input.maxEventsPerRun ?? 500;
    await condition(() => this.eventsThisRun >= max || continueAsNewSuggested());
    return continueAsNew<LoyaltyInput>(() => ({ customerId: input.customerId, points: this.points, recent: this.recent, maxEventsPerRun: max }));
  }
}
