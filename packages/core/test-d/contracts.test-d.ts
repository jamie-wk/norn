import { expectTypeOf } from 'vitest';
import {
  contract,
  defineWorkflow,
  query,
  signal,
  toMs,
  type,
  update,
  type ContractInput,
  type ContractOutput,
  type IdParams,
  type SearchAttributeValues,
} from '../src/index.ts';

interface Item {
  sku: string;
  qty: number;
}

// ---- manual contracts ----
const order = defineWorkflow({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  id: 'order-{orderId}',
  input: type<{ orderId: string; total: number }>(),
  output: type<{ status: 'shipped' | 'refunded' }>(),
  signals: { cancel: signal<[reason: string]>() },
  queries: { status: query<string>() },
  updates: { addItem: update<number, [item: Item]>() },
  searchAttributes: { CustomerId: 'keyword', Total: 'double' },
});

expectTypeOf<ContractInput<typeof order>>().toEqualTypeOf<{ orderId: string; total: number }>();
expectTypeOf<ContractOutput<typeof order>>().toEqualTypeOf<{ status: 'shipped' | 'refunded' }>();
expectTypeOf<IdParams<typeof order>>().toEqualTypeOf<{ orderId: string }>();
expectTypeOf(order.signals.cancel.__args).toEqualTypeOf<[reason: string] | undefined>();
expectTypeOf(order.updates.addItem.__result).toEqualTypeOf<number | undefined>();
expectTypeOf<SearchAttributeValues<typeof order>>().toEqualTypeOf<{ CustomerId?: string; Total?: number }>();

order.workflowId({ orderId: 'o1' });
// @ts-expect-error missing placeholder field
order.workflowId({});

// @ts-expect-error id placeholder must be a field of the input
defineWorkflow({ name: 'A', taskQueue: 'q', id: 'a-{missing}', input: type<{ orderId: string }>() });

// ---- generated contracts derived from a class ----
class OrderWorkflow {
  cancel(_reason: string) {}
  status() {
    return 'pending' as 'pending' | 'paid';
  }
  async addItem(_item: Item) {
    return 3;
  }
  notAHandler() {}
  async run(input: { orderId: string; customerId: string }) {
    return { status: 'shipped' as const, orderId: input.orderId };
  }
}

const generated = contract<typeof OrderWorkflow>()({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  id: 'order-{orderId}',
  signals: { cancel: 'cancel' },
  queries: { status: 'status' },
  updates: { addItem: 'addItem' },
});

expectTypeOf<ContractInput<typeof generated>>().toEqualTypeOf<{ orderId: string; customerId: string }>();
expectTypeOf<ContractOutput<typeof generated>>().toEqualTypeOf<{ status: 'shipped'; orderId: string }>();
expectTypeOf(generated.signals.cancel.__args).toEqualTypeOf<[_reason: string] | undefined>();
expectTypeOf(generated.queries.status.__result).toEqualTypeOf<'pending' | 'paid' | undefined>();
expectTypeOf(generated.updates.addItem.__result).toEqualTypeOf<number | undefined>();
expectTypeOf(generated.updates.addItem.__args).toEqualTypeOf<[_item: Item] | undefined>();

contract<typeof OrderWorkflow>()({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  // @ts-expect-error signals must name methods of the class
  signals: { nope: 'nope' },
});

contract<typeof OrderWorkflow>()({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  // @ts-expect-error id placeholder must be a field of run()'s input
  id: 'order-{nope}',
});

// A workflow whose run() takes no input
class TickWorkflow {
  async run() {
    return 1;
  }
}
const tick = contract<typeof TickWorkflow>()({ name: 'Tick', taskQueue: 'q' });
expectTypeOf<ContractInput<typeof tick>>().toEqualTypeOf<undefined>();

// ---- durations ----
toMs('5 days');
toMs('1m');
toMs('PT1M');
toMs(100);
// @ts-expect-error not a duration
toMs('soon');
