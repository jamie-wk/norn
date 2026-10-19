import { Workflow, Signal, Query } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  @Signal() cancel() {}
  @Signal() expedite() {}
  @Query('state') status() {
    return 'ok';
  }
  async run() {}
}
