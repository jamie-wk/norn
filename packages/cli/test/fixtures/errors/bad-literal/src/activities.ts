import { Activities, Activity } from '@norn-ts/activity';

const TIMEOUT = '1m';
const defaults = { local: true };

@Activities({ prefix: 'pay.' })
export class PayActivities {
  @Activity({ timeout: TIMEOUT }) async charge() {}
  @Activity({ retries: 1 + 2, ...defaults }) async refund() {}
  @Activity({ name: getName() }) async other() {}
}

function getName() {
  return 'other';
}
