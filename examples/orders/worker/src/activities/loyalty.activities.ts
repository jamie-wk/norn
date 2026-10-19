import { Activities, Activity, token } from '@norn-ts/activity';
import type { NornClient } from '@norn-ts/client';
import { LoyaltyWorkflow } from '../../.norn/contracts.ts';

export const TemporalClient = token<NornClient>('TemporalClient');

@Activities({ prefix: 'loyalty.', inject: [TemporalClient] })
export class LoyaltyActivities {
  constructor(private readonly client: NornClient) {}

  /** Credits points on the customer's long-running loyalty workflow, starting it if needed. */
  @Activity({ timeout: '20s', retries: 10 })
  async credit(customerId: string, orderId: string, cents: number) {
    await this.client
      .workflow(LoyaltyWorkflow)
      .signalWithStart({ customerId }, { signal: 'orderCompleted', args: [{ orderId, cents }] });
  }
}
