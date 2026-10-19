import { Workflow } from '@norn/workflow';

@Workflow({ taskQueue: 'orders', searchAttributes: { CustomerId: 'keyword', Total: 'double' } })
export class OrderWorkflow {
  async run() {}
}
