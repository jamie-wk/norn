import { Workflow, asFailure, useActivities, useChild } from '@norn-ts/workflow';
import { GreetActivities } from './refs.ts';

@Workflow({ taskQueue: 'w-reports' })
export class ReportWorkflow {
  private readonly acts = useActivities(GreetActivities);
  async run() {
    return { correlation: await this.acts.correlation() };
  }
}

@Workflow({ taskQueue: 'w-main', id: 'greet-{name}' })
export class GreetWorkflow {
  private readonly acts = useActivities(GreetActivities);
  private readonly report = useChild(ReportWorkflow);
  async run(input: { name: string }) {
    try {
      const greeting = await this.acts.hello(input.name);
      const correlation = await this.acts.correlation();
      const child = await this.report.execute(undefined, { workflowId: `report-${input.name}` });
      return { greeting, correlation, childCorrelation: child.correlation };
    } catch (error) {
      const failure = asFailure(error, 'BlockedNameError');
      if (failure) return { blocked: failure.message };
      throw error;
    }
  }
}

@Workflow({ taskQueue: 'w-main' })
export class SlowWorkflow {
  private readonly acts = useActivities(GreetActivities);
  async run(input: { ms: number }) {
    return this.acts.slow(input.ms);
  }
}
