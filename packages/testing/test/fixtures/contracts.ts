import { contract } from '@norn/core';
import type { ReminderWorkflow, WaitWorkflow } from './workflow-classes.ts';

export const Reminders = contract<typeof ReminderWorkflow>()({
  name: 'ReminderWorkflow',
  taskQueue: 'testing-q',
  id: 'reminder-{userId}',
  signals: { snooze: 'snooze' },
  queries: { status: 'status' },
});
export const Waits = contract<typeof WaitWorkflow>()({ name: 'WaitWorkflow', taskQueue: 'testing-q', signals: { finish: 'finish' } });
