import { Workflow } from '@norn-ts/workflow';
import { env, total } from '../lib/index.js';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  async run(input: { cents: number }) {
    return { total: total(input.cents), host: env() };
  }
}
