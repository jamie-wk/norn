import { Service, token } from '@norn-ts/activity';
import { PaymentDeclinedError } from '../domain.ts';
import { HttpClient, HttpError } from './http.ts';

export interface Charge {
  chargeId: string;
  amountCents: number;
}

/** The payment provider, behind an interface so tests and other providers can swap it. */
export interface PaymentGateway {
  charge(request: { orderId: string; amountCents: number; card: string; idempotencyKey: string }): Promise<Charge>;
  refund(request: { chargeId: string; idempotencyKey: string }): Promise<{ refundId: string }>;
}
export const PaymentGateway = token<PaymentGateway>('PaymentGateway');

@Service({ provides: PaymentGateway })
export class HttpPaymentGateway implements PaymentGateway {
  constructor(private readonly http: HttpClient) {}

  async charge(request: { orderId: string; amountCents: number; card: string; idempotencyKey: string }): Promise<Charge> {
    try {
      return await this.http.post<Charge>(
        '/charges',
        { orderId: request.orderId, amountCents: request.amountCents, card: request.card },
        { 'idempotency-key': request.idempotencyKey },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 402) {
        throw new PaymentDeclinedError((error.body as { reason?: string } | undefined)?.reason ?? 'card declined');
      }
      throw error;
    }
  }

  refund(request: { chargeId: string; idempotencyKey: string }): Promise<{ refundId: string }> {
    return this.http.post('/refunds', { chargeId: request.chargeId }, { 'idempotency-key': request.idempotencyKey });
  }
}
