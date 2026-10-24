// ReminderWorkflow with an incompatible change: an activity runs before the timer.
import type { Duration } from '@temporalio/common';
import { sleep } from '@temporalio/workflow';
import { Workflow, implement, useActivities } from '@norn-ts/workflow';
import { NotifyActivities } from './refs.ts';

@Workflow({ taskQueue: 'testing-q', name: 'ReminderWorkflow', id: 'reminder-{userId}' })
class ChangedReminder {
  private readonly notify = useActivities(NotifyActivities);
  async run(input: { userId: string; email: string; delay?: Duration }) {
    await this.notify.audit('scheduled');
    await sleep(input.delay ?? '1 day');
    const id = await this.notify.email(input.email, 'reminder');
    return { messageId: id, snoozed: 0 };
  }
}

export const ReminderWorkflow = implement(ChangedReminder);
