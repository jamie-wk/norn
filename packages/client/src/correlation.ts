import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import type { WorkflowClientInterceptor } from '@temporalio/client';
import { CORRELATION_HEADER } from '@norn-ts/core';

// Shared with @norn-ts/activity and @norn-ts/worker through globalThis, so separate copies of the
// packages (or a bundler) still agree on the current correlation ID.
const KEY = Symbol.for('norn.correlation');
const globals = globalThis as Record<symbol, unknown>;
const store = (globals[KEY] ??= new AsyncLocalStorage<string>()) as AsyncLocalStorage<string>;

/** The correlation ID of the current request, if one was set. */
export function getCorrelationId(): string | undefined {
  return store.getStore();
}

/**
 * Runs `fn` with a correlation ID. Workflows started, signalled, queried or updated inside it
 * carry the ID in a header; Norn workers pass it on to activities and their logs.
 */
export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return store.run(id, fn);
}

type WithHeaders = { headers: Record<string, Payload> };

function withCorrelation<I extends WithHeaders>(input: I): I {
  const id = store.getStore();
  if (id === undefined || input.headers[CORRELATION_HEADER] !== undefined) return input;
  return { ...input, headers: { ...input.headers, [CORRELATION_HEADER]: defaultPayloadConverter.toPayload(id) } };
}

/** A client interceptor that adds the current correlation ID to outbound workflow calls. */
export function correlationInterceptor(): WorkflowClientInterceptor {
  return {
    start: (input, next) => next(withCorrelation(input)),
    signal: (input, next) => next(withCorrelation(input)),
    signalWithStart: (input, next) => next(withCorrelation(input)),
    query: (input, next) => next(withCorrelation(input)),
    startUpdate: (input, next) => next(withCorrelation(input)),
    startUpdateWithStart: (input, next) =>
      next({ ...input, workflowStartHeaders: withCorrelation({ headers: input.workflowStartHeaders }).headers, updateHeaders: withCorrelation({ headers: input.updateHeaders }).headers }),
  };
}
