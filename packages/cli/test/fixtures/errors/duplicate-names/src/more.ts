import { Activities, Activity } from '@norn/activity';

@Activities({ prefix: 'more.' })
export class PayActivities {
  @Activity() async refund() {}
}
