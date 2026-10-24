import { contract } from '@norn-ts/core';
import type { CounterWorkflow, ReminderWorkflow, WaitWorkflow } from './workflow-classes.ts';

export const Reminders = contract<typeof ReminderWorkflow>()({
  name: 'ReminderWorkflow',
  taskQueue: 'testing-q',
  id: 'reminder-{userId}',
  signals: { snooze: 'snooze' },
  queries: { status: 'status' },
});
export const Waits = contract<typeof WaitWorkflow>()({ name: 'WaitWorkflow', taskQueue: 'testing-q', signals: { finish: 'finish' } });
export const Counters = contract<typeof CounterWorkflow>()({
  name: 'CounterWorkflow',
  taskQueue: 'testing-q',
  id: 'counter-{counterId}',
  signals: { finish: 'finish' },
  queries: { broken: 'broken' },
  updates: { add: 'add' },
});
