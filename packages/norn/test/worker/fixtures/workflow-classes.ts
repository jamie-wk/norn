import { Workflow, asFailure, useActivities, useChild } from '../../../src/workflow/index.ts';
import type { GreetActivities } from './activities.ts';

const greet = () => useActivities<GreetActivities>('greet', { nonRetryable: ['BlockedNameError'], methods: { slow: { timeout: '30s', heartbeat: '5s' } } });

@Workflow({ taskQueue: 'w-reports' })
export class ReportWorkflow {
  async run(input: { name: string }) {
    return `report for ${input.name}`;
  }
}

@Workflow({ taskQueue: 'w-main', id: 'greet-{name}' })
export class GreetWorkflow {
  private readonly acts = greet();
  private readonly report = useChild(ReportWorkflow);
  async run(input: { name: string }) {
    try {
      const greeting = await this.acts.hello(input.name);
      const report = await this.report.execute({ name: input.name }, { workflowId: `report-${input.name}` });
      return { greeting, report };
    } catch (error) {
      const failure = asFailure(error, 'BlockedNameError');
      if (failure) return { blocked: failure.message };
      throw error;
    }
  }
}

@Workflow({ taskQueue: 'w-main' })
export class SlowWorkflow {
  private readonly acts = greet();
  async run(input: { ms: number }) {
    return this.acts.slow(input.ms);
  }
}
