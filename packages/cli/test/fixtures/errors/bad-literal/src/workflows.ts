import { Workflow, Signal } from '@norn/workflow';

const QUEUE = 'orders';

@Workflow({ taskQueue: QUEUE })
export class OrderWorkflow {
  @Signal({ name: `cancel-${QUEUE}` }) cancel() {}
  async run() {}
}
