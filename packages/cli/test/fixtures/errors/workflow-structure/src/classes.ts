import { Workflow } from '@norn-ts/workflow';
import { Activities, Activity, Service } from '@norn-ts/activity';

@Activities({ prefix: 1 })
export class EmptyActivities {}

@Workflow({ taskQueue: 'orders' })
@Activities()
export class ConfusedClass {
  @Activity() async run() {}
}

@Service({ scope: 'request' })
export class BadService {}
