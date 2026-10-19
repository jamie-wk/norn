import { Workflow } from '@norn-ts/workflow';
import { CURRENCY } from '../activities/payment.js';
import type { PaymentActivities } from '../activities/payment.js';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  declare activities: PaymentActivities;
  async run() {
    return CURRENCY;
  }
}
