// The shape `norn gen` emits: types come from the classes through `import type` only.
import { contract } from '@norn-ts/core';
import type { CartWorkflow, EchoWorkflow, OrderWorkflow, TickWorkflow } from './workflow-classes.ts';

export const Orders = contract<typeof OrderWorkflow>()({
  name: 'OrderWorkflow',
  taskQueue: 'client-orders',
  id: 'order-{orderId}',
  signals: { cancel: 'cancel', close: 'close' },
  queries: { getItems: 'getItems', summary: 'summary' },
  updates: { addItem: 'addItem' },
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
});

export const Echo = contract<typeof EchoWorkflow>()({ name: 'EchoWorkflow', taskQueue: 'client-orders' });

export const Carts = contract<typeof CartWorkflow>()({
  name: 'CartWorkflow',
  taskQueue: 'client-orders',
  id: 'cart-{cartId}',
  signals: { push: 'push', checkout: 'checkout' },
  queries: { list: 'list' },
  updates: { add: 'add' },
});

export const Tick = contract<typeof TickWorkflow>()({ name: 'TickWorkflow', taskQueue: 'client-orders' });
