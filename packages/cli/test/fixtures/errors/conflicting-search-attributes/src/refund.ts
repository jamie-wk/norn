import { Workflow } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'orders', searchAttributes: { CustomerId: 'text', Total: 'double' } })
export class RefundWorkflow {
  async run() {}
}
