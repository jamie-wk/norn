import { Activities, Activity } from '@norn-ts/activity';

export function fee(cents: number) {
  return Math.round(cents * 0.03);
}

@Activities({ prefix: 'pay.' })
export class PaymentActivities {
  @Activity() async charge() {}
}
