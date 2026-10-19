import { ApplicationFailure, condition, sleep } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, setSearchAttributes } from '@norn-ts/workflow';

export class InvalidItemError extends Error {
  override name = 'InvalidItemError';
}

export interface OrderInput {
  orderId: string;
  customerId?: string;
  /** Fail the workflow with this ApplicationFailure type once it closes. */
  failWith?: string;
}

@Workflow({
  taskQueue: 'client-orders',
  id: 'order-{orderId}',
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
})
export class OrderWorkflow {
  private status: 'open' | 'closed' | 'canceled' = 'open';
  private readonly items: string[] = [];
  private reason = '';

  @Signal() cancel(reason: string) {
    this.status = 'canceled';
    this.reason = reason;
  }

  @Signal() close() {
    this.status = 'closed';
  }

  @Query() getItems(): string[] {
    return [...this.items];
  }

  @Query() summary(prefix: string) {
    return `${prefix}:${this.status}:${this.items.length}`;
  }

  @Validate('addItem') checkItem(sku: string) {
    if (!sku) throw new InvalidItemError('sku is required');
  }

  @Update() addItem(sku: string) {
    if (sku === 'boom') throw ApplicationFailure.create({ type: 'OutOfStockError', message: 'out of stock' });
    this.items.push(sku);
    return this.items.length;
  }

  async run(input: OrderInput) {
    setSearchAttributes({ OrderStatus: 'open', ...(input.customerId ? { CustomerId: input.customerId } : {}) });
    await condition(() => this.status !== 'open');
    setSearchAttributes({ OrderStatus: this.status });
    if (input.failWith) throw ApplicationFailure.create({ type: input.failWith, message: `failed: ${input.failWith}`, nonRetryable: true });
    return { status: this.status, items: [...this.items], reason: this.reason };
  }
}

@Workflow({ taskQueue: 'client-orders' })
export class EchoWorkflow {
  async run(input: { value: string; delayMs?: number }) {
    if (input.delayMs) await sleep(input.delayMs);
    return input.value.toUpperCase();
  }
}

@Workflow({ taskQueue: 'client-orders', id: 'cart-{cartId}' })
export class CartWorkflow {
  private readonly items: string[] = [];
  private done = false;

  @Update() add(sku: string) {
    this.items.push(sku);
    return [...this.items];
  }

  @Signal() push(sku: string) {
    this.items.push(sku);
  }

  @Signal() checkout() {
    this.done = true;
  }

  @Query() list() {
    return [...this.items];
  }

  async run(_input: { cartId: string }) {
    await condition(() => this.done);
    return this.items;
  }
}

@Workflow({ taskQueue: 'client-orders' })
export class TickWorkflow {
  async run() {
    return 'tick';
  }
}
