import { Workflow, Signal, Query, Update } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'a' })
export class OrderWorkflow {
  @Signal() cancel() {}
  @Signal('cancel') cancelAgain() {}
  @Query() status() {}
  @Query({ name: 'status' }) status2() {}
  @Update() set() {}
  async run() {}
}

@Workflow({ taskQueue: 'b', name: 'OrderWorkflow' })
export class LegacyOrderWorkflow {
  async run() {}
}
