import { condition, sleep, workflowInfo } from '@temporalio/workflow';
import {
  Query,
  Signal,
  Update,
  Validate,
  Workflow,
  asFailure,
  continueAsNew,
  setSearchAttributes,
  useActivities,
  useChild,
  useExternal,
} from '../../src/index.ts';
import { payments } from './registry.ts';

export class InvalidItemError extends Error {
  override name = 'InvalidItemError';
}
export class InvalidInputError extends Error {
  override name = 'InvalidInputError';
}

interface OrderInput {
  orderId: string;
  cents: number;
  customerId?: string;
  slowSignalMs?: number;
}

@Workflow({
  taskQueue: 'orders',
  id: 'order-{orderId}',
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
})
export class OrderWorkflow {
  private status: 'pending' | 'paid' | 'canceled' | 'refunded' = 'pending';
  private readonly items: string[] = [];
  private readonly events: string[] = [];
  private readonly orderId: string;
  private readonly pay = useActivities(payments);

  constructor(input: OrderInput) {
    // Workflow init: handlers registered right after this can read the input.
    this.orderId = input.orderId;
  }

  @Signal() cancel(_reason: string) {
    if (this.status === 'pending' || this.status === 'paid') this.status = 'canceled';
  }

  @Signal({ name: 'transfer-event', dedupeBy: (e: { eventId: string }) => e.eventId })
  transferEvent(e: { eventId: string }) {
    this.events.push(e.eventId);
  }

  @Signal() async audit(ms: number) {
    // A slow, async signal handler: the workflow must not complete until it finishes.
    await this.pay.slow(ms);
    this.events.push('audited');
  }

  @Query() getStatus() {
    return { orderId: this.orderId, status: this.status, items: [...this.items], events: [...this.events] };
  }

  @Validate('addItem') checkItem(sku: string) {
    if (!sku) throw new InvalidItemError('sku is required');
    if (this.status !== 'pending' && this.status !== 'paid') throw new InvalidItemError(`order is ${this.status}`);
  }

  @Update() addItem(sku: string) {
    this.items.push(sku);
    return this.items.length;
  }

  async run(input: OrderInput) {
    if (input.customerId) setSearchAttributes({ CustomerId: input.customerId });
    const charge = await this.pay.charge(input.orderId, input.cents);
    this.status = 'paid';
    setSearchAttributes({ OrderStatus: 'paid' });
    const canceled = await condition(() => this.status === 'canceled', '1 hour');
    if (canceled) {
      await this.pay.refund(charge.id);
      this.status = 'refunded';
    }
    return { status: this.status, chargeId: charge.id, items: [...this.items], events: [...this.events] };
  }
}

@Workflow({ taskQueue: 'orders', id: 'cart-{cartId}' })
export class CartWorkflow {
  private readonly items: string[];
  private checkedOut = false;

  constructor(input: { cartId: string; seed?: string[] }) {
    this.items = [...(input.seed ?? [])];
  }

  @Update() add(sku: string) {
    this.items.push(sku);
    return { count: this.items.length };
  }

  @Signal() checkout() {
    this.checkedOut = true;
  }

  async run(_input: { cartId: string; seed?: string[] }) {
    await condition(() => this.checkedOut, '1 day');
    return [...this.items];
  }
}

@Workflow({ taskQueue: 'orders', failOn: [InvalidInputError] })
export class StrictWorkflow {
  async run(input: { value: number }) {
    if (input.value < 0) throw new InvalidInputError('value must be positive');
    return input.value * 2;
  }
}

@Workflow({ taskQueue: 'orders' })
export class FailureWorkflow {
  private readonly pay = useActivities(payments);
  async run() {
    try {
      await this.pay.reject();
      return { ok: true as const };
    } catch (error) {
      const rejected = asFailure(error, 'PaymentRejectedError');
      if (!rejected) throw error;
      return { ok: false as const, reason: rejected.message, type: rejected.type };
    }
  }
}

@Workflow({ taskQueue: 'orders' })
export class RetryWorkflow {
  private readonly pay = useActivities(payments);
  async run() {
    return this.pay.flaky();
  }
}

@Workflow({ taskQueue: 'shipping', id: 'ship-{orderId}' })
export class ShipmentWorkflow {
  private expedited = 0;
  @Signal() expedite(level: number) {
    this.expedited = level;
  }
  async run(input: { orderId: string }) {
    await sleep(10);
    return { trackingId: `trk_${input.orderId}`, expedited: this.expedited, parent: workflowInfo().parent?.workflowId ?? null };
  }
}

@Workflow({ taskQueue: 'orders', id: 'parent-{orderId}' })
export class ParentWorkflow {
  private readonly ship = useChild(ShipmentWorkflow);
  async run(input: { orderId: string; cancelOrder?: string }) {
    const shipped = await this.ship.execute({ orderId: input.orderId });
    if (input.cancelOrder) {
      await useExternal(OrderWorkflow, { orderId: input.cancelOrder }).signal('cancel', 'from parent');
    }
    return shipped;
  }
}

class Pausable {
  protected paused = false;
  @Signal() pause() {
    this.paused = true;
  }
  @Signal() resume() {
    this.paused = false;
  }
  @Query() isPaused() {
    return this.paused;
  }
}

@Workflow({ taskQueue: 'orders' })
export class PausableJobWorkflow extends Pausable {
  private done = false;
  @Signal() finish() {
    this.done = true;
  }
  // Overrides keep the inherited @Signal registration and run the subclass implementation.
  override resume() {
    super.resume();
  }
  async run() {
    await condition(() => this.done && !this.paused);
    return 'finished';
  }
}

@Workflow({ taskQueue: 'orders', id: 'counter-{counterId}' })
export class CounterWorkflow {
  private count: number;
  private readonly runs: number;
  constructor(input: { counterId: string; count?: number; runs?: number }) {
    this.count = input.count ?? 0;
    this.runs = input.runs ?? 1;
  }
  @Signal() increment() {
    this.count++;
  }
  @Query() value() {
    return { count: this.count, runs: this.runs };
  }
  async run(input: { counterId: string; count?: number; runs?: number; target: number; perRun: number }) {
    // Not this.count: signals that arrived before the first workflow task are already applied here.
    const startCount = input.count ?? 0;
    await condition(() => this.count >= input.target || this.count - startCount >= input.perRun);
    if (this.count >= input.target) return { count: this.count, runs: this.runs };
    return continueAsNew({ ...input, count: this.count, runs: this.runs + 1 });
  }
}

interface CarryInput {
  total?: number;
  rolled?: boolean;
}

/** Continues as new while an async update is still running: the update's effect must reach the next run. */
@Workflow({ taskQueue: 'orders' })
export class CarryWorkflow {
  private total: number;
  private updating = false;
  private readonly pay = useActivities(payments);
  constructor(input: CarryInput) {
    this.total = input.total ?? 0;
  }
  @Update() async add(n: number) {
    this.updating = true;
    await this.pay.slow(300);
    this.total += n;
    return this.total;
  }
  async run(input: CarryInput) {
    if (input.rolled) return this.total;
    await condition(() => this.updating);
    return continueAsNew<CarryInput>(() => ({ total: this.total, rolled: true }));
  }
}
