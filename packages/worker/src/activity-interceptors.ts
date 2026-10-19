import { defaultPayloadConverter } from '@temporalio/common';
import type { ActivityInterceptorsFactory } from '@temporalio/worker';
import { CORRELATION_HEADER } from '@norn-ts/core';
import { runWithCorrelationId } from '@norn-ts/activity';

/** Runs each activity with the correlation ID its workflow carried, so logs and outbound calls can use it. */
export const correlationActivityInterceptor: ActivityInterceptorsFactory = () => ({
  inbound: {
    execute(input, next) {
      const header = input.headers[CORRELATION_HEADER];
      if (!header) return next(input);
      let id: unknown;
      try {
        id = defaultPayloadConverter.fromPayload(header);
      } catch {
        return next(input);
      }
      return typeof id === 'string' ? runWithCorrelationId(id, () => next(input)) : next(input);
    },
  },
});
