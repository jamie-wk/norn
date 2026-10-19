import { Activities, Activity, Service } from '@norn-ts/activity';

@Service()
export class Mailer {
  readonly sent: string[] = [];
  async send(to: string, body: string) {
    this.sent.push(`${to}:${body}`);
    return `msg-${this.sent.length}`;
  }
}

@Activities({ prefix: 'notify.', inject: [Mailer] })
export class NotifyActivities {
  constructor(private readonly mailer: Mailer) {}
  @Activity() async email(to: string, body: string) {
    return this.mailer.send(to, body);
  }
  @Activity() async audit(event: string) {
    return `audited ${event}`;
  }
}
