import { condition } from '@temporalio/workflow';
import { Query as Q, Signal, Update, Workflow } from '@norn-ts/workflow';
import { Pausable } from './base.js';

@Workflow({
  taskQueue: 'carts',
  name: 'ShoppingCart',
  id: 'cart-{cartId}',
  searchAttributes: { CustomerId: 'keyword', CartSize: 'int' },
  drainHandlers: true,
})
export class CartWorkflow extends Pausable {
  private readonly items: string[] = [];
  private checkedOut = false;

  @Update() add(sku: string) {
    this.items.push(sku);
    return { count: this.items.length };
  }

  @Signal() checkout() {
    this.checkedOut = true;
  }

  @Q() contents() {
    return [...this.items];
  }

  async run(_input: { cartId: string }) {
    await condition(() => this.checkedOut && !this.paused);
    return [...this.items];
  }
}
