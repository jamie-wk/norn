import type { PaymentGateway } from '../services/payment-gateway';

// Activities are where I/O happens: a plain class. Temporal retries failed calls with the options
// the workflow sets in useActivities().
export class PaymentActivities {
  constructor(private readonly gateway: PaymentGateway) {}

  /** The order ID is the idempotency key, so a retried attempt never charges twice. */
  async charge(orderId: string, cents: number) {
    return this.gateway.charge({ orderId, cents, idempotencyKey: `charge-${orderId}` });
  }

  async refund(chargeId: string) {
    return this.gateway.refund(chargeId);
  }
}
