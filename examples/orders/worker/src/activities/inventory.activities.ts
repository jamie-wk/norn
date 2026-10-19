import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { OutOfStockError, PRICES, type LineItem } from '../domain.ts';

/** In-memory stock, standing in for an inventory service. */
const stock = new Map<string, number>(Object.keys(PRICES).map((sku) => [sku, 1_000]));
const reservations = new Map<string, LineItem[]>();

@Activities({ prefix: 'inventory.' })
export class InventoryActivities {
  /** Reserves stock and prices the order. Idempotent per order. */
  @Activity({ timeout: '10s', local: true })
  @NonRetryable([OutOfStockError])
  async reserve(orderId: string, items: LineItem[]) {
    if (!reservations.has(orderId)) {
      for (const item of items) {
        const available = stock.get(item.sku) ?? 0;
        if (available < item.qty) throw new OutOfStockError(`${item.sku} is out of stock`);
      }
      for (const item of items) stock.set(item.sku, (stock.get(item.sku) ?? 0) - item.qty);
      reservations.set(orderId, items);
    }
    return { totalCents: items.reduce((sum, item) => sum + (PRICES[item.sku] ?? 0) * item.qty, 0) };
  }

  @Activity({ timeout: '10s', local: true })
  async release(orderId: string) {
    for (const item of reservations.get(orderId) ?? []) stock.set(item.sku, (stock.get(item.sku) ?? 0) + item.qty);
    reservations.delete(orderId);
  }
}
