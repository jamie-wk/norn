import { expectTypeOf } from 'vitest';
import {
  Signal,
  Update,
  Validate,
  Workflow,
  asFailure,
  continueAsNew,
  implement,
  isFailure,
  useActivities,
  useChild,
} from '../../../src/workflow/index.ts';

interface Item {
  sku: string;
  qty: number;
}

// ---- ID templates are checked against run()'s input ----
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
class GoodId {
  async run(_input: { orderId: string }) {}
}

// @ts-expect-error orderId is not a field of the input
@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
class BadId {
  async run(_input: { id: string }) {}
}

// ---- validators must name an update method with matching parameters ----
class Validated {
  @Validate('addItem') check(_item: Item) {}
  @Update() addItem(_item: Item) {
    return 1;
  }

  // @ts-expect-error parameters don't match addItem's
  @Validate('addItem') wrongArgs(_n: number) {}

  // @ts-expect-error no such update method
  @Validate('nope') unknown() {}

  async run() {}
}

// ---- dedupeBy receives the signal's arguments ----
class Deduped {
  @Signal({ dedupeBy: (e: { eventId: string }) => e.eventId }) event(_e: { eventId: string }) {}
  async run() {}
}

// ---- implement() keeps run()'s types ----
const goodFn = implement(GoodId);
expectTypeOf(goodFn).parameters.toEqualTypeOf<[input: { orderId: string }]>();
expectTypeOf(goodFn).returns.toEqualTypeOf<Promise<void>>();

// ---- typed activities from a type-only class ----
class PaymentActivities {
  constructor(private readonly _db: unknown) {}
  async charge(orderId: string, cents: number) {
    return { id: `${orderId}:${cents}` };
  }
  refund(_chargeId: string) {
    return true;
  }
}

const pay = useActivities<PaymentActivities>('payments', { timeout: '1m', methods: { refund: { retries: 3 } } });
expectTypeOf(pay.charge).toEqualTypeOf<(orderId: string, cents: number) => Promise<{ id: string }>>();
expectTypeOf(pay.refund).toEqualTypeOf<(_chargeId: string) => Promise<boolean>>();
// @ts-expect-error not a method of the class
void pay.nope;
// @ts-expect-error not a method of the class
useActivities<PaymentActivities>('payments', { methods: { nope: {} } });

// ---- typed children ----
@Workflow({ taskQueue: 'shipping', id: 'ship-{orderId}' })
class ShipmentWorkflow {
  @Signal() expedite(_level: number) {}
  async run(input: { orderId: string }) {
    return { trackingId: input.orderId };
  }
}
const ship = useChild(ShipmentWorkflow);
expectTypeOf(ship.execute).parameters.toEqualTypeOf<[input: { orderId: string }, options?: import('../../../src/workflow/index.ts').ChildOptions]>();
expectTypeOf(ship.execute).returns.toEqualTypeOf<Promise<{ trackingId: string }>>();

// ---- failure matching ----
class PaymentRejectedError extends Error {}
declare const err: unknown;
expectTypeOf(isFailure(err, PaymentRejectedError)).toBeBoolean();
expectTypeOf(isFailure(err, 'PaymentRejectedError')).toBeBoolean();
const rejected = asFailure(err, PaymentRejectedError);
if (rejected) {
  expectTypeOf(rejected.message).toBeString();
  expectTypeOf(rejected.type).toEqualTypeOf<string | undefined | null>();
}

export { BadId, Deduped, Validated };

// continueAsNew takes the input, or a function returning it (read after in-flight handlers finish).
async function _continueAsNewInput(count: number) {
  expectTypeOf(continueAsNew<{ count: number }>).parameter(0).toEqualTypeOf<{ count: number } | (() => { count: number })>();
  await continueAsNew<{ count: number }>(() => ({ count }));
  // @ts-expect-error the thunk must return the declared input
  await continueAsNew<{ count: number }>(() => ({ count: 'x' }));
}
