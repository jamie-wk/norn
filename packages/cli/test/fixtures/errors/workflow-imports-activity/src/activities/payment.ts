import { Activities, Activity } from '@norn-ts/activity';

export const CURRENCY = 'USD';

@Activities({ prefix: 'pay.' })
export class PaymentActivities {
  @Activity() async charge() {
    return CURRENCY;
  }
}
