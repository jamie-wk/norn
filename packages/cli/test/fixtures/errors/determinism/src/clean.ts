import { sleep, uuid4 } from '@temporalio/workflow';
import { Workflow } from '@norn/workflow';

const setTimeout = (fn: () => void) => fn();

@Workflow({ taskQueue: 'orders' })
export class CleanWorkflow {
  async run() {
    await sleep('1s');
    setTimeout(() => {});
    return { id: uuid4(), at: Date.now(), r: Math.random() };
  }
}
