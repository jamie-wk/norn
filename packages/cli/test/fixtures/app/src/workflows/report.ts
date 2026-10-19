import * as wf from '@norn/workflow';
import { ReportActivities } from '../../.norn/activities.js';

export interface ReportInput {
  kind: 'daily' | 'weekly';
}

@wf.Schedule('0 2 * * *', {
  id: 'nightly-report',
  input: { kind: 'daily' },
  timeZone: 'America/New_York',
  overlap: 'buffer-one',
  note: 'Nightly totals',
})
@wf.Schedule(['0 9 * * 1', '0 9 * * 4'], { input: { kind: 'weekly' }, paused: true, pauseOnFailure: true })
@wf.Workflow({ taskQueue: 'reports' })
export class ReportWorkflow {
  private readonly reports = wf.useActivities(ReportActivities);

  async run(input: ReportInput) {
    return this.reports.buildReport(input.kind);
  }
}
