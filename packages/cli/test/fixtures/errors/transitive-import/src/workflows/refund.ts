import { Workflow } from '@norn-ts/workflow';
import { total } from '../lib/money.js';

@Workflow({ taskQueue: 'orders' })
export class RefundWorkflow {
  async run(input: { cents: number }) {
    return -total(input.cents);
  }
}
