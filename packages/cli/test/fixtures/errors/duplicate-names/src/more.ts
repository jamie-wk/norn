import { Activities, Activity } from '@norn-ts/activity';

@Activities({ prefix: 'more.' })
export class PayActivities {
  @Activity() async refund() {}
}
