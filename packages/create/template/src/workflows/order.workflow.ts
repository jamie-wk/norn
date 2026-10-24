import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn-ts/workflow';
// A type-only import: workflows never load activity code, they schedule it by name.
import type { PaymentActivities } from '../activities/payment.activities';

export interface OrderInput {
  orderId: string;
  cents: number;
}

export type OrderStatus = 'pending' | 'paid' | 'refunded';

/** How long a paid order can still be canceled (and refunded). */
const cancellationWindow = '5 minutes';

/** Charges an order, then refunds it if it is canceled within the cancellation window. */
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: OrderStatus = 'pending';
  private canceled = false;
  private readonly payments = useActivities<PaymentActivities>('payments', {
    timeout: '30s',
    retries: 3,
    nonRetryable: ['CardDeclinedError'],
    methods: { refund: { retries: 10 } },
  });

  @Signal() cancel(_reason: string) {
    this.canceled = true;
  }

  @Query() getStatus(): OrderStatus {
    return this.status;
  }

  async run(input: OrderInput): Promise<OrderStatus> {
    const charge = await this.payments.charge(input.orderId, input.cents);
    this.status = 'paid';
    // A durable timer: it survives worker restarts. condition() returns false when it runs out.
    if (await condition(() => this.canceled, cancellationWindow)) {
      await this.payments.refund(charge.id);
      this.status = 'refunded';
    }
    return this.status;
  }
}
