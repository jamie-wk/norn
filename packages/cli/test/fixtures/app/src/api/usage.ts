// Type-level checks that generated contracts and activity refs carry the workflow and activity types.
import type { ContractInput, ContractOutput, RefArgs, RefResult } from '@norn-ts/core';
import type { ActivityProxy } from '@norn-ts/workflow';
import { OrderWorkflow, ShoppingCart } from '../../.norn/contracts.js';
import { ReportWorkflow } from '../../shared/contracts.js';
import type { PaymentActivities } from '../../.norn/activities.js';
import type { OrderStatus } from '../workflows/order.js';
import type { NornClient } from '@norn-ts/client';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type Checks = [
  Expect<Equal<ContractInput<typeof OrderWorkflow>['orderId'], string>>,
  Expect<Equal<ContractOutput<typeof OrderWorkflow>['chargeId'], string>>,
  Expect<Equal<RefArgs<typeof OrderWorkflow.signals.cancel>, [_reason: string]>>,
  Expect<Equal<RefResult<typeof OrderWorkflow.queries.getStatus>['status'], OrderStatus>>,
  Expect<Equal<RefResult<typeof OrderWorkflow.updates.addItem>, number>>,
  Expect<Equal<RefResult<typeof ShoppingCart.updates.add>, { count: number }>>,
  Expect<Equal<RefResult<typeof ShoppingCart.queries.isPaused>, boolean>>,
  Expect<Equal<ContractOutput<typeof ReportWorkflow>, string>>,
  Expect<Equal<ReturnType<ActivityProxy<typeof PaymentActivities>['refund']>, Promise<boolean>>>,
];

export const exampleId: string = OrderWorkflow.workflowId({ orderId: 'o-1' });
export const queue: 'orders' = OrderWorkflow.taskQueue as 'orders';
export const signalName: string = OrderWorkflow.signals.transferEvent.name;
export const cartName: string = ShoppingCart.name;

/** API code: typed starts, updates, queries and signals through the generated contracts. */
export async function placeOrder(norn: NornClient, orderId: string): Promise<OrderStatus> {
  const handle = await norn.workflow(OrderWorkflow).start({ orderId, cents: 1200, wait: true });
  const count: number = await handle.update('addItem', 'sku-1');
  await handle.signal('transferEvent', { eventId: `evt-${count}` });
  // @ts-expect-error cancel() takes a reason
  await handle.signal('cancel');
  // @ts-expect-error not a signal of OrderWorkflow
  await handle.signal('checkout');
  const cart = norn.workflow(ShoppingCart).get({ cartId: 'c-1' });
  await cart.signal('pause');
  const { status } = await handle.query('getStatus');
  return status;
}
