/** Notification activities, registered as `notify.<method>`. Workflows import this type only. */
export class NotifyActivities {
  readonly sent: string[] = [];
  async email(to: string, body: string) {
    this.sent.push(`${to}:${body}`);
    return `msg-${this.sent.length}`;
  }
  async audit(event: string) {
    return `audited ${event}`;
  }
}
