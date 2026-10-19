import { Activities, Activity } from '@norn/activity';

export const CURRENCY = 'USD';

@Activities({ prefix: 'pay.' })
export class PaymentActivities {
  @Activity() async charge() {
    return CURRENCY;
  }
}
