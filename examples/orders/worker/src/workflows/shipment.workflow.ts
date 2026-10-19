import { Workflow, useActivities } from '@norn-ts/workflow';
import { ShippingActivities } from '../../.norn/activities.ts';

/** Runs on its own task queue so shipping capacity scales separately from orders. */
@Workflow({ taskQueue: 'shipping', id: 'shipment-{orderId}' })
export class ShipmentWorkflow {
  private readonly shipping = useActivities(ShippingActivities);

  async run(input: { orderId: string }) {
    return this.shipping.createLabel(input.orderId);
  }
}
