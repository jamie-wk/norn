import { Workflow } from '@norn/workflow';

@Workflow({ taskQueue: 'orders', searchAttributes: { CustomerId: 'text', Total: 'double' } })
export class RefundWorkflow {
  async run() {}
}
