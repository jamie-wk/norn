import { condition, sleep } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn/workflow';
import { NotifyActivities } from './refs.ts';

@Workflow({ taskQueue: 'testing-q', id: 'reminder-{userId}' })
export class ReminderWorkflow {
  private readonly notify = useActivities(NotifyActivities);
  private snoozed = 0;
  private stage = 'waiting';

  @Signal() snooze() {
    this.snoozed++;
  }

  @Query() status() {
    return { stage: this.stage, snoozed: this.snoozed };
  }

  async run(input: { userId: string; email: string; delay?: string }) {
    await sleep(input.delay ?? '1 day');
    this.stage = 'sending';
    const id = await this.notify.email(input.email, `reminder after ${this.snoozed} snoozes`);
    await this.notify.audit('reminded');
    this.stage = 'done';
    return { messageId: id, snoozed: this.snoozed };
  }
}

@Workflow({ taskQueue: 'testing-q' })
export class WaitWorkflow {
  private open = true;
  @Signal() finish() {
    this.open = false;
  }
  async run() {
    await condition(() => !this.open);
    return 'finished';
  }
}
