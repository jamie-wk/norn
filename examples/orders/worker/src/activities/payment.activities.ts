import { Activities, Activity, NonRetryable } from '@norn/activity';
import { PaymentDeclinedError } from '../domain.ts';
import { PaymentGateway } from '../services/payment-gateway.ts';

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  constructor(private readonly gateway: PaymentGateway) {}

  /** Charges the card. The order ID is the idempotency key, so retries never double-charge. */
  @Activity({ timeout: '30s', retries: 5, retry: { initialInterval: '200ms', maximumInterval: '5s' } })
  @NonRetryable([PaymentDeclinedError])
  async charge(orderId: string, amountCents: number, card: string) {
    return this.gateway.charge({ orderId, amountCents, card, idempotencyKey: `charge-${orderId}` });
  }

  @Activity({ timeout: '30s', retries: 10 })
  async refund(orderId: string, chargeId: string) {
    return this.gateway.refund({ chargeId, idempotencyKey: `refund-${orderId}` });
  }
}
