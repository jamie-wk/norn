// Shared domain types and errors. Workflow-safe: no I/O, no Node APIs.

export interface LineItem {
  sku: string;
  qty: number;
}

export interface OrderInput {
  orderId: string;
  customerId: string;
  email: string;
  card: string;
  items?: LineItem[];
  /** Submit immediately (default when items are given), or wait for the `submit` update. */
  submit?: boolean;
  /** How long the customer may cancel after paying, before the order ships. */
  cancelWindow?: string;
}

export type OrderStatus =
  | 'open'
  | 'charging'
  | 'paid'
  | 'shipping'
  | 'completed'
  | 'payment_failed'
  | 'rejected'
  | 'canceled'
  | 'refunded'
  | 'expired'
  | 'charged_back';

export interface OrderView {
  orderId: string;
  status: OrderStatus;
  items: LineItem[];
  totalCents: number;
  chargeId?: string;
  trackingNumber?: string;
  failure?: string;
}

/** Prices in cents. A real app would look these up in an activity. */
export const PRICES: Readonly<Record<string, number>> = Object.freeze({
  'sku-book': 1_500,
  'sku-mug': 900,
  'sku-shirt': 2_400,
  'sku-sticker': 200,
});

/** Why an item can't be ordered, or undefined when it can. */
export function itemError(item: LineItem | undefined): string | undefined {
  if (!item || typeof item.sku !== 'string' || !Object.hasOwn(PRICES, item.sku)) return `Unknown SKU ${String(item?.sku)}`;
  if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100) return 'qty must be a whole number from 1 to 100';
  return undefined;
}

export class InvalidItemError extends Error {
  override name = 'InvalidItemError';
}
export class OrderStateError extends Error {
  override name = 'OrderStateError';
}
export class PaymentDeclinedError extends Error {
  override name = 'PaymentDeclinedError';
}
export class OutOfStockError extends Error {
  override name = 'OutOfStockError';
}
