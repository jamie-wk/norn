import { describe, expect, it } from 'vitest';
import { NornConfigError } from '@norn/core';
import { Query, Signal, Update, Validate, Workflow, describeWorkflow, isWorkflowClass } from '../src/index.ts';

class InvalidItemError extends Error {}

@Workflow({
  taskQueue: 'orders',
  id: 'order-{orderId}',
  versioning: 'auto-upgrade',
  searchAttributes: { CustomerId: 'keyword' },
  failOn: [InvalidItemError],
})
class OrderWorkflow {
  status = 'pending';
  items = 0;
  @Signal() cancel(_reason: string) {}
  @Signal({ name: 'transfer-event', unfinishedPolicy: 'abandon', dedupeBy: (e: { eventId: string }) => e.eventId })
  transferEvent(_e: { eventId: string }) {}
  @Query() getStatus() {
    return this.status;
  }
  @Validate('addItem') checkItem(qty: number) {
    if (qty < 1) throw new InvalidItemError('qty');
  }
  @Update() addItem(_qty: number) {
    return ++this.items;
  }
  async run(input: { orderId: string }) {
    return input.orderId;
  }
}

describe('describeWorkflow', () => {
  const def = describeWorkflow(OrderWorkflow);

  it('reads class options with defaults', () => {
    expect(def).toMatchObject({
      className: 'OrderWorkflow',
      name: 'OrderWorkflow',
      taskQueue: 'orders',
      idTemplate: 'order-{orderId}',
      versioning: 'auto-upgrade',
      searchAttributes: { CustomerId: 'keyword' },
      failOn: [InvalidItemError],
      drainHandlers: true,
    });
    expect(isWorkflowClass(OrderWorkflow)).toBe(true);
  });

  it('lists handlers with registered names and options', () => {
    expect(def.signals.map((s) => [s.method, s.name, s.unfinishedPolicy])).toEqual([
      ['cancel', 'cancel', undefined],
      ['transferEvent', 'transfer-event', 'abandon'],
    ]);
    expect(def.signals[1]?.dedupeBy?.({ eventId: 'e1' })).toBe('e1');
    expect(def.queries.map((q) => q.name)).toEqual(['getStatus']);
    expect(def.updates).toEqual([expect.objectContaining({ method: 'addItem', name: 'addItem', validator: 'checkItem' })]);
  });

  it('uses a custom workflow type name', () => {
    @Workflow({ taskQueue: 'q', name: 'OrderV2' })
    class Named {
      async run() {}
    }
    expect(describeWorkflow(Named).name).toBe('OrderV2');
  });

  it('inherits handlers from base classes and dispatches to overrides', () => {
    class Pausable {
      paused = false;
      @Signal() pause() {
        this.paused = true;
      }
      @Query() isPaused() {
        return this.paused;
      }
    }
    @Workflow({ taskQueue: 'q' })
    class Child extends Pausable {
      @Signal() resume() {}
      async run() {}
    }
    expect(describeWorkflow(Child).signals.map((s) => s.name).sort()).toEqual(['pause', 'resume']);
    expect(describeWorkflow(Child).queries.map((q) => q.name)).toEqual(['isPaused']);
  });

  it('rejects classes without @Workflow', () => {
    class Plain {
      async run() {}
    }
    expect(isWorkflowClass(Plain)).toBe(false);
    expect(() => describeWorkflow(Plain)).toThrow(/not decorated with @Workflow/);
  });
});

describe('definition-time validation', () => {
  it('rejects a missing task queue', () => {
    expect(() => {
      @Workflow({ taskQueue: '' })
      class _A {
        async run() {}
      }
    }).toThrow(NornConfigError);
  });

  it('rejects names that are not valid identifiers', () => {
    expect(() => {
      @Workflow({ taskQueue: 'q', name: 'order-v2' })
      class _A {
        async run() {}
      }
    }).toThrow(/identifier/);
  });

  it('rejects malformed ID templates', () => {
    expect(() => {
      @Workflow({ taskQueue: 'q', id: 'order-{' as 'order-{x}' })
      class _A {
        async run(_i: { x: string }) {}
      }
    }).toThrow(/template/);
  });

  it('rejects unknown versioning behaviors and search attribute types', () => {
    expect(() => {
      @Workflow({ taskQueue: 'q', versioning: 'sometimes' as 'pinned' })
      class _A {
        async run() {}
      }
    }).toThrow(/versioning/);
    expect(() => {
      @Workflow({ taskQueue: 'q', searchAttributes: { X: 'blob' as 'text' } })
      class _B {
        async run() {}
      }
    }).toThrow(/search attribute/);
  });

  it('rejects classes without a run() method', () => {
    expect(() => {
      // @ts-expect-error run() is required
      @Workflow({ taskQueue: 'q' })
      class _A {}
    }).toThrow(/run\(\)/);
  });

  it('rejects duplicate handler names', () => {
    @Workflow({ taskQueue: 'q' })
    class Dupes {
      @Signal('go') a() {}
      @Signal('go') b() {}
      async run() {}
    }
    expect(() => describeWorkflow(Dupes)).toThrow(/"go"/);
  });

  it('rejects validators for unknown updates', () => {
    @Workflow({ taskQueue: 'q' })
    class Orphan {
      @Validate('missing' as never) check() {}
      async run() {}
    }
    expect(() => describeWorkflow(Orphan)).toThrow(/missing/);
  });

  it('rejects two validators for one update', () => {
    @Workflow({ taskQueue: 'q' })
    class Twice {
      @Validate('add') v1(_n: number) {}
      @Validate('add') v2(_n: number) {}
      @Update() add(_n: number) {}
      async run() {}
    }
    expect(() => describeWorkflow(Twice)).toThrow(/more than one validator/);
  });

  it('rejects async query handlers', () => {
    expect(() => {
      class _Q {
        // @ts-expect-error queries must be synchronous
        @Query() async bad() {
          return 1;
        }
      }
    }).toThrow(/synchronous/);
  });

  it('rejects private and static handlers', () => {
    expect(() => {
      class _P {
        @Signal() #hidden() {}
      }
    }).toThrow(/private/);
    expect(() => {
      class _S {
        @Signal() static nope() {}
      }
    }).toThrow(/static/);
  });

  it('rejects applying @Workflow twice', () => {
    expect(() => {
      @Workflow({ taskQueue: 'a' })
      @Workflow({ taskQueue: 'b' })
      class _Twice {
        async run() {}
      }
    }).toThrow(/already/);
  });
});
