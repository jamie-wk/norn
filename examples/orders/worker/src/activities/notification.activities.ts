import { Activities, Activity, idempotencyKey } from '@norn/activity';
import { Mailer } from '../services/mailer.ts';

@Activities({ prefix: 'notify.' })
export class NotificationActivities {
  constructor(private readonly mailer: Mailer) {}

  @Activity({ timeout: '20s', retries: 8 })
  async email(to: string, template: string, data: Record<string, unknown>) {
    return this.mailer.send({ to, template, data: { ...data, idempotencyKey: idempotencyKey() } });
  }
}
