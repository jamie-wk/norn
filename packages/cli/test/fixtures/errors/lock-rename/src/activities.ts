import { Activities, Activity } from '@norn/activity';

@Activities({ prefix: 'pay.' })
export class PaymentActivities {
  @Activity() async charge() {}
}
