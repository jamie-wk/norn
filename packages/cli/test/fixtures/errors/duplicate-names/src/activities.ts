import { Activities, Activity } from '@norn/activity';

@Activities({ prefix: 'pay.' })
export class PayActivities {
  @Activity() async charge() {}
  @Activity({ name: 'charge' }) async chargeAgain() {}
}

@Activities({ prefix: 'pay.' })
export class MorePayActivities {
  @Activity() async charge() {}
}
