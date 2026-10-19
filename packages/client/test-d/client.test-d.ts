import { expectTypeOf } from 'vitest';
import { createClient } from '../src/index.ts';
import { Carts, Echo, Orders, Tick } from '../test/fixtures/contracts.ts';

const norn = createClient();
const orders = norn.workflow(Orders);

async function types() {
  const handle = await orders.start({ orderId: 'o1' }, { searchAttributes: { CustomerId: 'c1' }, ifRunning: 'useExisting' });
  expectTypeOf(await handle.query('getItems')).toEqualTypeOf<string[]>();
  expectTypeOf(await handle.query('summary', 'x')).toEqualTypeOf<string>();
  expectTypeOf(await handle.update('addItem', 'sku')).toEqualTypeOf<number>();
  expectTypeOf(await handle.result()).toEqualTypeOf<{ status: 'open' | 'closed' | 'canceled'; items: string[]; reason: string }>();
  await handle.signal('cancel', 'why');
  await handle.signal('close');

  // @ts-expect-error unknown signal
  await handle.signal('nope');
  // @ts-expect-error wrong argument type
  await handle.signal('cancel', 42);
  // @ts-expect-error missing argument
  await handle.query('summary');
  // @ts-expect-error orderId is required by the ID template
  await orders.start({ customerId: 'c' });
  // @ts-expect-error search attribute value type
  await orders.start({ orderId: 'o' }, { searchAttributes: { CustomerId: 1 } });
  // @ts-expect-error undeclared search attribute
  await orders.start({ orderId: 'o' }, { searchAttributes: { Other: 'x' } });

  orders.get({ orderId: 'o1' });
  orders.get({ workflowId: 'order-o1', runId: 'r' });

  expectTypeOf(await norn.workflow(Echo).execute({ value: 'x' }, { workflowId: 'e' })).toEqualTypeOf<string>();
  await norn.workflow(Tick).start(undefined, { workflowId: 't' });
  await norn.workflow(Tick).start();

  const { result } = await norn.workflow(Carts).updateWithStart({ cartId: 'c' }, { update: 'add', args: ['sku'] });
  expectTypeOf(result).toEqualTypeOf<string[]>();
  // @ts-expect-error wrong update args
  await norn.workflow(Carts).updateWithStart({ cartId: 'c' }, { update: 'add', args: [1] });
  await norn.workflow(Carts).signalWithStart({ cartId: 'c' }, { signal: 'push', args: ['a'] });
  // @ts-expect-error checkout is a signal, not an update
  await norn.workflow(Carts).updateWithStart({ cartId: 'c' }, { update: 'checkout', args: [] });
}
void types;
