import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, type Info } from '@temporalio/activity';
import { NornConfigError } from '@norn/core';

function current(fn: string): Context {
  try {
    return Context.current();
  } catch (error) {
    throw new NornConfigError(`${fn} can only be called while an activity is running`, { cause: error });
  }
}

/** Information about the running activity: IDs, attempt, task queue and workflow. */
export function activityInfo(): Info {
  return current('activityInfo()').info;
}

/**
 * A key that stays the same across retries of one scheduled activity, for idempotent side effects
 * such as charges or emails. For money movement, prefer a business key such as a payment ID.
 */
export function idempotencyKey(suffix?: string): string {
  const { workflowExecution, activityId } = current('idempotencyKey()').info;
  const base = workflowExecution
    ? `${workflowExecution.workflowId}/${workflowExecution.runId}/${activityId}`
    : `activity/${activityId}`;
  return suffix ? `${base}/${suffix}` : base;
}

/** Records progress. Long-running activities must heartbeat more often than their heartbeat timeout. */
export function heartbeat(details?: unknown): void {
  current('heartbeat()').heartbeat(details);
}

/** The details of the last heartbeat from a previous attempt, so a retry can resume. */
export function lastHeartbeat<T>(): T | undefined {
  return current('lastHeartbeat()').info.heartbeatDetails as T | undefined;
}

/** Aborts when the activity is cancelled; pass it to fetch() and other cancellable calls. */
export function cancellationSignal(): AbortSignal {
  return current('cancellationSignal()').cancellationSignal;
}

// Correlation IDs are shared through a process-wide AsyncLocalStorage so @norn/client (API side)
// and @norn/activity (worker side) agree even when installed as separate copies.
const KEY = Symbol.for('norn.correlation');
type Store = AsyncLocalStorage<string>;
const correlation: Store = ((globalThis as Record<symbol, unknown>)[KEY] as Store | undefined) ??
  ((globalThis as Record<symbol, unknown>)[KEY] = new AsyncLocalStorage<string>()) as Store;

/** The correlation ID of the current request or activity, if one was set. */
export function getCorrelationId(): string | undefined {
  return correlation.getStore();
}

/** Runs `fn` with a correlation ID, propagated to workflows and activities started inside it. */
export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return correlation.run(id, fn);
}
