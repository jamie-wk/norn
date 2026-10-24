import { formatDuration, toMs, type Duration } from './duration.js';
import { NornConfigError } from './errors.js';

export interface RetryOptions {
  initialInterval?: Duration;
  backoffCoefficient?: number;
  maximumInterval?: Duration;
  /** Total attempts including the first. */
  maximumAttempts?: number;
}

/** How activities are scheduled: timeouts, retries and where they run. Passed to `useActivities()`. */
export interface ActivityOptions {
  /** Start-to-close timeout: how long a single attempt may run. Defaults to 1 minute. */
  timeout?: Duration;
  /** Total time allowed across all attempts. */
  scheduleToClose?: Duration;
  /** How long the task may wait in the queue before a worker picks it up. */
  scheduleToStart?: Duration;
  /** Heartbeat timeout; long-running activities should call `heartbeat()` more often than this. */
  heartbeat?: Duration;
  /** Retries after the first attempt. `0` means a single attempt. */
  retries?: number;
  /** A full retry policy. Use either `retries` or `retry.maximumAttempts`, not both. */
  retry?: RetryOptions;
  /** Run as a local activity: lower latency, no heartbeats, same worker. */
  local?: boolean;
  /** Error type names (the error's `name`) that must never be retried. */
  nonRetryable?: readonly string[];
  /** Run on a different task queue than the calling workflow. */
  taskQueue?: string;
  /** Short summary shown in the Temporal UI. */
  summary?: string;
}

/** Temporal SDK activity options produced from {@link ActivityOptions}. */
export interface TemporalActivityOptions {
  startToCloseTimeout?: `${number}ms`;
  scheduleToCloseTimeout?: `${number}ms`;
  scheduleToStartTimeout?: `${number}ms`;
  heartbeatTimeout?: `${number}ms`;
  taskQueue?: string;
  summary?: string;
  retry?: {
    initialInterval?: `${number}ms`;
    backoffCoefficient?: number;
    maximumInterval?: `${number}ms`;
    maximumAttempts?: number;
    nonRetryableErrorTypes?: string[];
  };
}

/** Default start-to-close timeout, in milliseconds, when an activity sets no timeout. */
export const DEFAULT_ACTIVITY_TIMEOUT = 60_000;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new NornConfigError(`Activity options: ${message}`);
}

/** Temporal treats zero as unset (timeouts) or rejects it (retry intervals), so these must be positive. */
function positive(duration: Duration, field: string): `${number}ms` {
  check(toMs(duration) > 0, `${field} must be greater than zero`);
  return formatDuration(duration);
}

/** Translates Norn activity options into Temporal SDK options. */
export function toActivityOptions(o: ActivityOptions): TemporalActivityOptions {
  const out: TemporalActivityOptions = {};

  if (o.timeout !== undefined) out.startToCloseTimeout = positive(o.timeout, 'timeout');
  if (o.scheduleToClose !== undefined) out.scheduleToCloseTimeout = positive(o.scheduleToClose, 'scheduleToClose');
  if (out.startToCloseTimeout === undefined && out.scheduleToCloseTimeout === undefined) {
    out.startToCloseTimeout = `${DEFAULT_ACTIVITY_TIMEOUT}ms`;
  }
  if (!o.local) {
    if (o.scheduleToStart !== undefined) out.scheduleToStartTimeout = formatDuration(o.scheduleToStart);
    if (o.heartbeat !== undefined) out.heartbeatTimeout = formatDuration(o.heartbeat);
    if (o.taskQueue !== undefined) out.taskQueue = o.taskQueue;
  }
  if (o.summary !== undefined) out.summary = o.summary;

  const retry: NonNullable<TemporalActivityOptions['retry']> = {};
  if (o.retry) {
    const r = o.retry;
    if (r.initialInterval !== undefined) retry.initialInterval = positive(r.initialInterval, 'retry.initialInterval');
    if (r.backoffCoefficient !== undefined) {
      check(r.backoffCoefficient >= 1, `retry.backoffCoefficient must be at least 1, got ${r.backoffCoefficient}`);
      retry.backoffCoefficient = r.backoffCoefficient;
    }
    if (r.maximumInterval !== undefined) retry.maximumInterval = positive(r.maximumInterval, 'retry.maximumInterval');
    if (r.maximumAttempts !== undefined) {
      check(Number.isInteger(r.maximumAttempts) && r.maximumAttempts > 0, 'retry.maximumAttempts must be a positive integer');
      retry.maximumAttempts = r.maximumAttempts;
    }
  }
  if (o.retries !== undefined) {
    check(Number.isInteger(o.retries) && o.retries >= 0, `retries must be a non-negative integer, got ${o.retries}`);
    check(o.retry?.maximumAttempts === undefined, 'use either retries or retry.maximumAttempts, not both');
    retry.maximumAttempts = o.retries + 1;
  }
  if (o.nonRetryable && o.nonRetryable.length > 0) retry.nonRetryableErrorTypes = [...o.nonRetryable];
  if (Object.keys(retry).length > 0) out.retry = retry;
  return out;
}
