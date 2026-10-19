import { Activities, Activity } from '@norn-ts/activity';

@Activities({ prefix: 'pay.' })
export class PaymentActivities {
  @Activity() async charge() {}
}
