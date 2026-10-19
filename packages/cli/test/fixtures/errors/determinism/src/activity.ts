import { Activities, Activity } from '@norn/activity';

@Activities()
export class TimerActivities {
  @Activity() async wait() {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return process.env.HOME ?? crypto.randomUUID();
  }
}
