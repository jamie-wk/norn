import { Service, token } from '@norn-ts/activity';

export interface Charge {
  id: string;
  cents: number;
}

export class CardDeclinedError extends Error {
  // Norn records an error's name as its failure type; an explicit name survives minification.
  override name = 'CardDeclinedError';
}

export interface PaymentGateway {
  charge(request: { orderId: string; cents: number; idempotencyKey: string }): Promise<Charge>;
  refund(chargeId: string): Promise<boolean>;
}
// A token with the same name as the interface, so activities can ask for a PaymentGateway by type.
export const PaymentGateway = token<PaymentGateway>('PaymentGateway');

/** A stand-in gateway. Swap it for a real provider by writing another @Service for the same token. */
@Service({ provides: PaymentGateway })
export class FakePaymentGateway implements PaymentGateway {
  async charge(request: { orderId: string; cents: number; idempotencyKey: string }): Promise<Charge> {
    if (request.cents <= 0) throw new CardDeclinedError('amount must be positive');
    console.log(`charged ${request.cents} cents for ${request.orderId}`);
    return { id: `ch_${request.orderId}`, cents: request.cents };
  }

  async refund(chargeId: string) {
    console.log(`refunded ${chargeId}`);
    return true;
  }
}
