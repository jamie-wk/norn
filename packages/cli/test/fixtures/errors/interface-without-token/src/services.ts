import { Activities, Activity } from '@norn-ts/activity';
import type { Mailer } from './mailer.js';

export interface Clock {
  now(): number;
}

@Activities()
export class NotifyActivities {
  constructor(
    private readonly clock: Clock,
    private readonly mailer: Mailer,
  ) {}

  @Activity() async notify() {
    return this.clock.now() + (await this.mailer.send());
  }
}
