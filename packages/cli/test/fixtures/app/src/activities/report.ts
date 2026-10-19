import { Activities, Activity } from '@norn-ts/activity';
import type { Db } from '../services/tokens.js';

@Activities()
export class ReportActivities {
  constructor(private readonly db: Db) {}

  @Activity({ heartbeat: '10s', scheduleToClose: '10m', retry: { maximumAttempts: 5 }, summary: `Build a report` })
  async buildReport(kind: 'daily' | 'weekly'): Promise<string> {
    return `${kind}:${(await this.db.get('transfers')) ?? 0}`;
  }
}
