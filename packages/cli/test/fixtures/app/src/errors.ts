export class InvalidCardError extends Error {
  override name = 'InvalidCardError';
}

export class OutOfStockError extends Error {
  override name = 'OutOfStockError';
}

export class InvalidOrderError extends Error {
  override name = 'InvalidOrderError';
}
