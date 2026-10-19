import { describe, expect, it } from 'vitest';
import { NornConfigError } from '@norn-ts/core';
import { Workflow, defineActivities, implement, activityName } from '../src/index.ts';

class BadInput extends Error {}

@Workflow({ taskQueue: 'q', versioning: 'auto-upgrade', failOn: [BadInput] })
class VersionedWorkflow {
  async run() {
    return 1;
  }
}

@Workflow({ taskQueue: 'q', name: 'Renamed', versioning: 'pinned' })
class PinnedWorkflow {
  async run() {}
}

@Workflow({ taskQueue: 'q' })
class PlainWorkflow {
  async run() {}
}

describe('implement', () => {
  it('names the workflow function after the workflow type', () => {
    const fn = implement(PinnedWorkflow);
    expect(fn.name).toBe('Renamed');
    expect(fn.workflowType).toBe('Renamed');
  });

  it('attaches versioning behavior and failure types as Temporal workflow options', () => {
    const versioned = implement(VersionedWorkflow) as unknown as { workflowDefinitionOptions: unknown };
    expect(versioned.workflowDefinitionOptions).toEqual({ versioningBehavior: 'AUTO_UPGRADE', failureExceptionTypes: [BadInput] });
    const pinned = implement(PinnedWorkflow) as unknown as { workflowDefinitionOptions: unknown };
    expect(pinned.workflowDefinitionOptions).toEqual({ versioningBehavior: 'PINNED' });
  });

  it('leaves workflow options unset when nothing is configured', () => {
    expect((implement(PlainWorkflow) as unknown as { workflowDefinitionOptions?: unknown }).workflowDefinitionOptions).toBeUndefined();
  });

  it('rejects classes without @Workflow', () => {
    class Nope {
      async run() {}
    }
    expect(() => implement(Nope)).toThrow(NornConfigError);
  });
});

describe('defineActivities', () => {
  class Acts {
    async charge(_id: string) {
      return 1;
    }
    async refund() {}
  }
  const ref = defineActivities<Acts>()({ prefix: 'payments.', methods: { charge: { timeout: '1m' }, refund: { name: 'refundCharge' } } });

  it('builds a frozen, workflow-safe reference', () => {
    expect(ref).toEqual({ kind: 'norn.activities', prefix: 'payments.', methods: { charge: { timeout: '1m' }, refund: { name: 'refundCharge' } } });
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.isFrozen(ref.methods)).toBe(true);
  });

  it('computes registered activity names with prefix and custom names', () => {
    expect(activityName(ref, 'charge')).toBe('payments.charge');
    expect(activityName(ref, 'refund')).toBe('payments.refundCharge');
    expect(() => activityName(ref, 'missing')).toThrow(/not registered/);
  });
});
