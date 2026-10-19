import { Schedule, Workflow, useActivities } from '@norn/workflow';
import { NotificationActivities } from '../../.norn/activities.ts';

/** Emails the ops team every morning. Created by `norn schedules sync`. */
@Workflow({ taskQueue: 'orders' })
@Schedule('0 9 * * *', { id: 'daily-sales-report', timeZone: 'America/Chicago', overlap: 'skip', note: 'Morning sales summary' })
export class DailyReportWorkflow {
  private readonly notify = useActivities(NotificationActivities);

  async run() {
    await this.notify.email('ops@example.com', 'daily_report', {});
    return 'sent';
  }
}
