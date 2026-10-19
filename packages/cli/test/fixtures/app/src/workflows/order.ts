import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, useActivities } from '@norn-ts/workflow';
import { InventoryActivities, PaymentActivities } from '../../.norn/activities.js';
import { InvalidOrderError } from '../errors.js';

export interface OrderInput {
  orderId: string;
  cents: number;
  customerId?: string;
  /** Keep the order open until it is canceled or completed. */
  wait?: boolean;
}

export type OrderStatus = 'pending' | 'paid' | 'canceled' | 'refunded' | 'completed';

@Workflow({
  taskQueue: 'orders',
  id: 'order-{orderId}',
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
  failOn: [InvalidOrderError],
})
export class OrderWorkflow {
  private status: OrderStatus = 'pending';
  private readonly items: string[] = [];
  private readonly events: string[] = [];
  private readonly pay = useActivities(PaymentActivities);
  private readonly stock = useActivities(InventoryActivities);

  constructor(private readonly input: OrderInput) {}

  /** Cancel the order and refund the charge. */
  @Signal()
  cancel(_reason: string) {
    if (this.status === 'pending' || this.status === 'paid') this.status = 'canceled';
  }

  @Signal({ name: 'transfer-event', dedupeBy: (event: { eventId: string }) => event.eventId, unfinishedPolicy: 'abandon' })
  transferEvent(event: { eventId: string }) {
    this.events.push(event.eventId);
  }

  @Signal() complete() {
    if (this.status === 'paid') this.status = 'completed';
  }

  @Query('status') getStatus(): { orderId: string; status: OrderStatus; items: string[] } {
    return { orderId: this.input.orderId, status: this.status, items: [...this.items] };
  }

  @Validate('addItem') checkItem(sku: string) {
    if (!sku) throw new InvalidOrderError('sku is required');
  }

  @Update({ name: 'add-item', description: 'Add an item to the order.' })
  addItem(sku: string): number {
    this.items.push(sku);
    return this.items.length;
  }

  async run(input: OrderInput) {
    if (input.cents <= 0) throw new InvalidOrderError('cents must be positive');
    const charge = await this.pay.charge(input.orderId, input.cents);
    this.status = 'paid';
    if (input.wait) await condition(() => this.status !== 'paid');
    // Handlers change the status while run() waits.
    if ((this.status as OrderStatus) === 'canceled') {
      await this.pay.refund(charge.id);
      this.status = 'refunded';
    } else {
      this.status = 'completed';
    }
    const stock = this.items.length > 0 ? await this.stock.reserve([...this.items]) : [];
    return { status: this.status, chargeId: charge.id, items: [...this.items], stock, events: [...this.events] };
  }
}
