import { Workflow, Signal, Update, Validate } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  @Signal() cancel() {}
  @Update() add(_sku: string) {}

  @Validate('cancel') checkCancel() {}
  @Validate('missing') checkMissing() {}
  @Validate('add') checkAdd(_sku: string) {}
  @Validate('add') checkAddAgain(_sku: string) {}
  async run() {}
}
