import type { Duration } from '@temporalio/common';
import { condition, sleep } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow, useActivities } from '@norn-ts/workflow';
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

  async run(input: { userId: string; email: string; delay?: Duration }) {
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

export class NegativeError extends Error {
  override name = 'NegativeError';
}

/** Every client error path: a validated update, a failing query, and a signal that finishes the run. */
@Workflow({ taskQueue: 'testing-q', id: 'counter-{counterId}' })
export class CounterWorkflow {
  private total = 0;
  private done = false;
  @Validate('add') checkAdd(n: number) {
    if (n < 0) throw new NegativeError('n must not be negative');
  }
  @Update() add(n: number) {
    this.total += n;
    return this.total;
  }
  @Query() broken(): number {
    throw new Error('broken query');
  }
  @Signal() finish() {
    this.done = true;
  }
  async run(_input: { counterId: string }) {
    await condition(() => this.done);
    return this.total;
  }
}
