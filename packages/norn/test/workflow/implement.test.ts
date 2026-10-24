import { describe, expect, it } from 'vitest';
import { NornConfigError } from '../../src/core/index.ts';
import { Workflow, implement } from '../../src/workflow/index.ts';

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
