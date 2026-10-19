import { Workflow } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'orders', searchAttributes: { CustomerId: 'keyword', Total: 'double' } })
export class OrderWorkflow {
  async run() {}
}
