import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { CardDeclinedError, PaymentGateway } from '../services/payment-gateway';

// Activities are where I/O happens. Temporal retries them; workflows call them through .norn/activities.
@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  // norn gen sees the PaymentGateway type and wires the matching @Service in.
  constructor(private readonly gateway: PaymentGateway) {}

  /** The order ID is the idempotency key, so a retried attempt never charges twice. */
  @Activity({ timeout: '30s', retries: 3 })
  @NonRetryable([CardDeclinedError])
  async charge(orderId: string, cents: number) {
    return this.gateway.charge({ orderId, cents, idempotencyKey: `charge-${orderId}` });
  }

  @Activity({ timeout: '30s', retries: 10 })
  async refund(chargeId: string) {
    return this.gateway.refund(chargeId);
  }
}
