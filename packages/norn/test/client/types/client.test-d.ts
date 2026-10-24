import { expectTypeOf } from 'vitest';
import { createClient } from '../../../src/client/index.ts';
import { CartWorkflow, EchoWorkflow, OrderWorkflow, TickWorkflow } from '../fixtures/workflow-classes.ts';

const norn = createClient();
const orders = norn.workflow(OrderWorkflow);

async function types() {
  const handle = await orders.start({ orderId: 'o1' }, { searchAttributes: { CustomerId: 'c1' }, ifRunning: 'useExisting' });
  expectTypeOf(await handle.query('getItems')).toEqualTypeOf<string[]>();
  expectTypeOf(await handle.query('summary', 'x')).toEqualTypeOf<string>();
  expectTypeOf(await handle.update('addItem', 'sku')).toEqualTypeOf<number>();
  expectTypeOf(await handle.result()).toEqualTypeOf<{ status: 'open' | 'closed' | 'canceled'; items: string[]; reason: string }>();
  await handle.signal('cancel', 'why');
  await handle.signal('close');

  // @ts-expect-error not a method of the workflow
  await handle.signal('nope');
  // @ts-expect-error wrong argument type
  await handle.signal('cancel', 42);
  // @ts-expect-error missing argument
  await handle.query('summary');
  // @ts-expect-error orderId is required by the input
  await orders.start({ customerId: 'c' });
  // @ts-expect-error run() is not a handler
  await handle.signal('run');

  orders.get({ orderId: 'o1' });
  orders.get({ workflowId: 'order-o1', runId: 'r' });
  // @ts-expect-error not a field of the input
  orders.get({ orderID: 'o1' });

  expectTypeOf(await norn.workflow(EchoWorkflow).execute({ value: 'x' }, { workflowId: 'e' })).toEqualTypeOf<string>();
  await norn.workflow(TickWorkflow).start(undefined, { workflowId: 't' });
  await norn.workflow(TickWorkflow).start();

  const { result } = await norn.workflow(CartWorkflow).updateWithStart({ cartId: 'c' }, { update: 'add', args: ['sku'] });
  expectTypeOf(result).toEqualTypeOf<string[]>();
  // @ts-expect-error wrong update args
  await norn.workflow(CartWorkflow).updateWithStart({ cartId: 'c' }, { update: 'add', args: [1] });
  await norn.workflow(CartWorkflow).signalWithStart({ cartId: 'c' }, { signal: 'push', args: ['a'] });

  // @ts-expect-error not a @Workflow-shaped class
  norn.workflow(class NoRun {});
}
void types;
