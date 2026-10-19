import { Service } from '@norn-ts/activity';
import { HttpClient } from './http.ts';

@Service()
export class ShippingService {
  constructor(private readonly http: HttpClient) {}
  createShipment(orderId: string, idempotencyKey: string) {
    return this.http.post<{ trackingNumber: string }>('/shipments', { orderId }, { 'idempotency-key': idempotencyKey });
  }
}
