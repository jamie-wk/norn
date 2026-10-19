import { fee } from '../activities/payment.js';

export function total(cents: number) {
  return cents + fee(cents);
}
