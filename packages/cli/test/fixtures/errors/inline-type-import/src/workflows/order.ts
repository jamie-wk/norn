import { Workflow } from '@norn/workflow';
import { type PaymentActivities } from '../activities/payment.js';
import { type Info } from '@temporalio/activity';
import type { PaymentActivities as Pay } from '../activities/payment.js';
import type * as fs from 'node:fs';
import { type WorkflowInfo, sleep } from '@temporalio/workflow';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  declare a: PaymentActivities;
  declare b: Info;
  declare c: Pay;
  declare d: typeof fs;
  declare e: WorkflowInfo;
  async run() {
    await sleep(1);
  }
}
