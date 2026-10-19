import { Activities, Activity, NonRetryable } from '@norn/activity';
import { InvalidCardError } from '../errors.js';
import { Config, TransferService } from '../services/index.js';

export interface Charge {
  id: string;
  cents: number;
}

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  constructor(
    private readonly transfers: TransferService,
    private readonly config: Config,
  ) {}

  @Activity({ timeout: '1m', retries: 3 })
  @NonRetryable([InvalidCardError])
  async charge(orderId: string, cents: number): Promise<Charge> {
    if (cents <= 0) throw new InvalidCardError(`cannot charge ${cents} ${this.config.currency}`);
    const id = await this.transfers.send({ from: orderId, cents });
    return { id, cents };
  }

  @Activity({ name: 'refund-charge', timeout: '30s', retry: { initialInterval: '1s', backoffCoefficient: 2 } })
  async refund(chargeId: string): Promise<boolean> {
    return chargeId.length > 0;
  }
}
