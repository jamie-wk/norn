import { Activities, Activity, heartbeat } from '@norn-ts/activity';
import { ShippingService } from '../services/shipping.ts';

@Activities({ prefix: 'shipping.' })
export class ShippingActivities {
  constructor(private readonly shipping: ShippingService) {}

  /** Buys a label. Can be slow, so it heartbeats while waiting on the provider. */
  @Activity({ timeout: '2m', heartbeat: '10s', retries: 5 })
  async createLabel(orderId: string) {
    const timer = setInterval(() => heartbeat(), 1_000);
    try {
      return await this.shipping.createShipment(orderId, `shipment-${orderId}`);
    } finally {
      clearInterval(timer);
    }
  }
}
