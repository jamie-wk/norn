import { Activities, Activity, NonRetryable } from '@norn/activity';
import { OutOfStockError } from '../errors.js';
import { InventoryService } from '../services/inventory.js';

@Activities({ prefix: 'inventory.', inject: [InventoryService] })
@NonRetryable([OutOfStockError])
export class InventoryActivities {
  constructor(private readonly inventory: InventoryService) {}

  @Activity({ local: true, timeout: '5s' })
  async reserve(skus: string[]): Promise<number[]> {
    const left: number[] = [];
    for (const sku of skus) {
      const n = await this.inventory.take(sku);
      if (n < 0) throw new OutOfStockError(sku);
      left.push(n);
    }
    return left;
  }

  @Activity()
  @NonRetryable()
  async release(_skus: string[]): Promise<void> {}
}
