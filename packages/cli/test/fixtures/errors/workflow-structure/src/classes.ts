import { Workflow } from '@norn/workflow';
import { Activities, Activity, Service } from '@norn/activity';

@Activities({ prefix: 1 })
export class EmptyActivities {}

@Workflow({ taskQueue: 'orders' })
@Activities()
export class ConfusedClass {
  @Activity() async run() {}
}

@Service({ scope: 'request' })
export class BadService {}
