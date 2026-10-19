import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, asFailure, setSearchAttributes, transitions, useActivities, useChild } from '@norn-ts/workflow';
import { InventoryActivities, LoyaltyActivities, NotificationActivities, PaymentActivities } from '../../.norn/activities.ts';
import { InvalidItemError, OrderStateError, OutOfStockError, PaymentDeclinedError, itemError, type LineItem, type OrderInput, type OrderStatus, type OrderView } from '../domain.ts';
import { ShipmentWorkflow } from './shipment.workflow.ts';

export interface PaymentEvent {
  eventId: string;
  type: 'charge.disputed';
  chargeId: string;
}

/**
 * An order from cart to doorstep: collect items, charge once, allow cancellation for a while
 * after paying (with a refund), then ship and credit loyalty points.
 */
@Workflow({
  taskQueue: 'orders',
  id: 'order-{orderId}',
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
})
export class OrderWorkflow {
  private readonly payments = useActivities(PaymentActivities);
  private readonly inventory = useActivities(InventoryActivities);
  private readonly notify = useActivities(NotificationActivities);
  private readonly loyalty = useActivities(LoyaltyActivities);
  private readonly shipment = useChild(ShipmentWorkflow);

  private readonly status = transitions(
    {
      open: ['charging', 'canceled', 'expired', 'rejected'],
      charging: ['paid', 'payment_failed', 'rejected'],
      paid: ['shipping', 'refunded', 'charged_back'],
      shipping: ['completed'],
      completed: [],
      payment_failed: [],
      rejected: [],
      canceled: [],
      refunded: [],
      expired: [],
      charged_back: [],
    },
    'open',
  );
  private readonly orderId: string;
  private readonly items: LineItem[];
  private submitted: boolean;
  private cancelReason: string | undefined;
  private disputed = false;
  private totalCents = 0;
  private chargeId: string | undefined;
  private trackingNumber: string | undefined;
  private failure: string | undefined;

  constructor(input: OrderInput) {
    this.orderId = input.orderId;
    this.items = [...(input.items ?? [])];
    this.submitted = input.submit ?? this.items.length > 0;
  }

  @Query() view(): OrderView {
    return {
      orderId: this.orderId,
      status: this.status.current,
      items: this.items.map((i) => ({ ...i })),
      totalCents: this.totalCents,
      ...(this.chargeId ? { chargeId: this.chargeId } : {}),
      ...(this.trackingNumber ? { trackingNumber: this.trackingNumber } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  @Validate('addItem') checkItem(item: LineItem) {
    if (!this.status.is('open') || this.submitted) throw new OrderStateError(`Cannot add items to a ${this.status.current} order`);
    const error = itemError(item);
    if (error) throw new InvalidItemError(error);
  }

  /** Adds an item to an open order and returns the updated view. */
  @Update() addItem(item: LineItem): OrderView {
    const existing = this.items.find((i) => i.sku === item.sku);
    if (existing) existing.qty += item.qty;
    else this.items.push({ sku: item.sku, qty: item.qty });
    return this.view();
  }

  @Validate('submit') checkSubmit() {
    if (!this.status.is('open') || this.submitted) throw new OrderStateError(`Order is already ${this.submitted ? 'submitted' : this.status.current}`);
    if (this.items.length === 0) throw new InvalidItemError('Add at least one item before submitting');
  }

  /** Submits the order and waits for the payment result. */
  @Update() async submit(): Promise<OrderView> {
    this.submitted = true;
    await condition(() => !this.status.is('open') && !this.status.is('charging'));
    return this.view();
  }

  @Signal() cancel(reason: string) {
    this.cancelReason ??= reason || 'customer request';
  }

  /** Provider webhooks. Retried deliveries carry the same event ID and are ignored. */
  @Signal({ dedupeBy: (e: PaymentEvent) => e.eventId })
  paymentEvent(event: PaymentEvent) {
    if (event.type === 'charge.disputed' && event.chargeId === this.chargeId) this.disputed = true;
  }

  async run(input: OrderInput): Promise<OrderView> {
    setSearchAttributes({ CustomerId: input.customerId, OrderStatus: 'open' });
    // Starting items skip the addItem validator, so check them here before anything is charged.
    this.failure = this.items.map(itemError).find(Boolean);
    if (this.failure) return this.finish('rejected');

    const ready = await condition(() => this.submitted || this.cancelReason !== undefined, '7 days');
    if (!ready) return this.finish('expired');
    if (this.cancelReason !== undefined && !this.submitted) return this.finish('canceled');

    this.move('charging');
    try {
      this.totalCents = (await this.inventory.reserve(this.orderId, this.items)).totalCents;
    } catch (error) {
      const outOfStock = asFailure(error, OutOfStockError);
      if (!outOfStock) throw error;
      this.failure = outOfStock.message;
      return this.finish('rejected');
    }
    try {
      const charge = await this.payments.charge(this.orderId, this.totalCents, input.card);
      this.chargeId = charge.chargeId;
    } catch (error) {
      await this.inventory.release(this.orderId);
      const declined = asFailure(error, PaymentDeclinedError);
      if (!declined) throw error;
      this.failure = declined.message;
      await this.notify.email(input.email, 'payment_failed', { orderId: this.orderId, reason: declined.message });
      return this.finish('payment_failed');
    }
    this.move('paid');
    await this.notify.email(input.email, 'order_paid', { orderId: this.orderId, totalCents: this.totalCents });

    // The customer may cancel for a while after paying; a dispute stops fulfilment.
    await condition(() => this.cancelReason !== undefined || this.disputed, input.cancelWindow ?? '1 hour');
    if (this.disputed) {
      await this.inventory.release(this.orderId);
      return this.finish('charged_back');
    }
    if (this.cancelReason !== undefined) {
      await this.payments.refund(this.orderId, this.chargeId!);
      await this.inventory.release(this.orderId);
      await this.notify.email(input.email, 'order_refunded', { orderId: this.orderId, reason: this.cancelReason });
      return this.finish('refunded');
    }

    this.move('shipping');
    const { trackingNumber } = await this.shipment.execute({ orderId: this.orderId });
    this.trackingNumber = trackingNumber;
    await this.notify.email(input.email, 'order_shipped', { orderId: this.orderId, trackingNumber });
    await this.loyalty.credit(input.customerId, this.orderId, this.totalCents);
    return this.finish('completed');
  }

  private move(next: OrderStatus) {
    this.status.move(next);
    setSearchAttributes({ OrderStatus: next });
  }

  private finish(status: OrderStatus): OrderView {
    this.move(status);
    return this.view();
  }
}
