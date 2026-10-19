import { ApplicationFailure, TemporalFailure } from '@temporalio/common';
import { NornConfigError, errorTypeOf } from '@norn-ts/core';
import type { ErrorClass } from './decorators.js';

export type ErrorDecision = 'retryable' | 'non-retryable' | ApplicationFailure | undefined;

export interface ErrorMappingOptions {
  /** Treat errors with an HTTP `status` or `statusCode` of 4xx as final, except 408 and 429. */
  http?: boolean;
  /** Decide per error; return undefined to fall through to the defaults. */
  map?: (error: unknown, activityType: string) => ErrorDecision;
}

export function validateErrorOptions(options: ErrorMappingOptions | undefined): void {
  if (!options) return;
  if (options.http !== undefined && typeof options.http !== 'boolean') {
    throw new NornConfigError('errors.http must be a boolean');
  }
  if (options.map !== undefined && typeof options.map !== 'function') {
    throw new NornConfigError('errors.map must be a function');
  }
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = e.status ?? e.statusCode ?? e.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function toFailure(error: unknown, nonRetryable: boolean): ApplicationFailure {
  const message = error instanceof Error ? error.message : String(error);
  const failure = ApplicationFailure.create({ message, type: errorTypeOf(error), nonRetryable });
  if (error instanceof Error && error.stack) failure.stack = error.stack;
  return failure;
}

/**
 * Converts an error thrown by an activity into an `ApplicationFailure`, so workflows can match it
 * by class name with `asFailure()`, and decides whether Temporal retries it.
 */
export function mapActivityError(
  error: unknown,
  activityType: string,
  nonRetryable: readonly ErrorClass[] | true | undefined,
  options: ErrorMappingOptions = {},
): unknown {
  // Failures the SDK understands (ApplicationFailure, CancelledFailure, ...) are already final.
  if (error instanceof TemporalFailure) return error;
  if (nonRetryable === true || (nonRetryable && nonRetryable.some((cls) => error instanceof cls))) {
    return toFailure(error, true);
  }
  const decision = options.map?.(error, activityType);
  if (decision instanceof ApplicationFailure) return decision;
  if (decision === 'non-retryable') return toFailure(error, true);
  if (decision === 'retryable') return toFailure(error, false);
  if (options.http) {
    const status = httpStatus(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return toFailure(error, true);
    }
  }
  return toFailure(error, false);
}
