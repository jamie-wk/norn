import { Workflow, Signal, Query, Schedule } from '@norn/workflow';

@Workflow({ taskQueue: 'orders' })
export class NoRunWorkflow {
  @Signal() #secret() {}
  @Query() static count() {
    return 0;
  }
  @Signal ping() {}
}

@Workflow({ taskQueue: 'orders' })
class HiddenWorkflow {
  async run() {}
}

@Schedule('0 * * * *')
export class NotAWorkflow {
  async run() {}
}

@Schedule('every day', { overlap: 'sometimes' })
@Workflow({ taskQueue: '', name: 'bad-name', searchAttributes: { Size: 'number' }, versioning: 'sometimes' })
export class BadOptionsWorkflow {
  async run() {}
}

@Schedule('0 * * * *')
@Schedule('0 1 * * *')
@Workflow({ taskQueue: 'orders' })
export class TwiceScheduledWorkflow {
  async run() {}
}

export default HiddenWorkflow;
