import { Workflow } from '@norn/workflow';

function helper(process: { env: string }) {
  return process.env;
}

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  async run() {
    setTimeout(() => {}, 10);
    const id = setInterval(() => {}, 10);
    setImmediate(() => {});
    const region = process.env.REGION;
    const now = Temporal.Now.instant();
    const uuid = crypto.randomUUID();
    const t = performance.now();
    const ref = new WeakRef({});
    const reg = new FinalizationRegistry(() => {});
    const safe = { setTimeout: 1, crypto: 2 }.crypto;
    const timer: typeof setTimeout | undefined = undefined;
    return [id, region, now, uuid, t, ref, reg, safe, timer, helper({ env: 'x' })];
  }
}
