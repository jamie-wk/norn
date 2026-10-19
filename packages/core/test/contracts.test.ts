import { describe, expect, it } from 'vitest';
import {
  contract,
  defineWorkflow,
  isWorkflowContract,
  NornConfigError,
  query,
  signal,
  type,
  update,
} from '../src/index.ts';

interface Item {
  sku: string;
  qty: number;
}

describe('defineWorkflow', () => {
  const order = defineWorkflow({
    name: 'OrderWorkflow',
    taskQueue: 'orders',
    id: 'order-{orderId}',
    input: type<{ orderId: string; total: number }>(),
    output: type<{ status: string }>(),
    signals: { cancel: signal<[reason: string]>() },
    queries: { status: query<string>() },
    updates: { addItem: update<number, [item: Item]>('add-item') },
    searchAttributes: { CustomerId: 'keyword' },
  });

  it('builds a contract with names, queue and refs', () => {
    expect(isWorkflowContract(order)).toBe(true);
    expect(order.name).toBe('OrderWorkflow');
    expect(order.taskQueue).toBe('orders');
    expect(order.idTemplate).toBe('order-{orderId}');
    expect(order.signals.cancel).toMatchObject({ kind: 'signal', name: 'cancel' });
    expect(order.queries.status).toMatchObject({ kind: 'query', name: 'status' });
    expect(order.updates.addItem).toMatchObject({ kind: 'update', name: 'add-item' });
    expect(order.searchAttributes).toEqual({ CustomerId: 'keyword' });
  });

  it('computes workflow IDs from the template', () => {
    expect(order.workflowId({ orderId: 'o1' })).toBe('order-o1');
  });

  it('defaults handler maps to empty objects', () => {
    const c = defineWorkflow({ name: 'Ping', taskQueue: 'q' });
    expect(c.signals).toEqual({});
    expect(c.queries).toEqual({});
    expect(c.updates).toEqual({});
    expect(c.searchAttributes).toEqual({});
    expect(() => c.workflowId({} as never)).toThrow(/no ID template/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.signals)).toBe(true);
  });

  it.each([
    [{ name: '', taskQueue: 'q' }, /name/],
    [{ name: 'A', taskQueue: '' }, /taskQueue/],
    [{ name: 'A', taskQueue: 'q', id: 'x-{' }, /template/],
    [{ name: 'A', taskQueue: 'q', signals: { a: signal('dup'), b: signal('dup') } }, /dup/],
    [{ name: 'A', taskQueue: 'q', searchAttributes: { X: 'nope' } }, /search attribute/],
  ])('rejects invalid definitions (%#)', (def, message) => {
    expect(() => defineWorkflow(def as never)).toThrow(NornConfigError);
    expect(() => defineWorkflow(def as never)).toThrow(message);
  });
});

describe('contract<C>() for generated contracts', () => {
  class OrderWorkflow {
    cancel(_reason: string) {}
    status() {
      return 'pending' as const;
    }
    addItem(_item: Item) {
      return 1;
    }
    async run(input: { orderId: string }) {
      return { orderId: input.orderId };
    }
  }

  it('maps method keys to registered names', () => {
    const c = contract<typeof OrderWorkflow>()({
      name: 'OrderWorkflow',
      taskQueue: 'orders',
      id: 'order-{orderId}',
      signals: { cancel: 'cancel' },
      queries: { status: 'status' },
      updates: { addItem: 'add-item' },
    });
    expect(c.signals.cancel.name).toBe('cancel');
    expect(c.updates.addItem.name).toBe('add-item');
    expect(c.workflowId({ orderId: 'x' })).toBe('order-x');
  });
});
