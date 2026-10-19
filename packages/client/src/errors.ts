import {
  QueryNotRegisteredError,
  QueryRejectedError,
  ServiceError,
  WorkflowFailedError as TemporalWorkflowFailedError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
} from '@temporalio/client';
import {
  ApplicationFailure,
  CancelledFailure,
  TerminatedFailure,
  TimeoutFailure,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError as TemporalWorkflowNotFoundError,
} from '@temporalio/common';
import {
  NornError,
  QueryFailedError,
  TemporalUnavailableError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
} from '@norn/core';

export interface ErrorContext {
  workflowId: string;
  runId?: string;
  workflowType?: string;
  update?: string;
  query?: string;
}

const GRPC = { DEADLINE_EXCEEDED: 4, RESOURCE_EXHAUSTED: 8, UNAVAILABLE: 14 } as const;

/** The gRPC status under a Temporal RPC error; other services' gRPC errors are not Temporal's. */
function grpcError(error: unknown): { code: number; message?: string } | undefined {
  if (!(error instanceof ServiceError || error instanceof WorkflowUpdateRPCTimeoutOrCancelledError)) return undefined;
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (typeof (e as { code?: unknown }).code === 'number') return e as { code: number; message?: string };
  }
  return undefined;
}

/** Names a workflow failure by its cause: the ApplicationFailure type, or Terminated/Cancelled/TimedOut. */
export function failureTypeOf(cause: unknown): string {
  if (cause instanceof ApplicationFailure) return cause.type ?? 'Error';
  if (cause instanceof TerminatedFailure) return 'Terminated';
  if (cause instanceof CancelledFailure) return 'Cancelled';
  if (cause instanceof TimeoutFailure) return 'TimedOut';
  if (cause instanceof Error) return cause.name;
  return 'Unknown';
}

/**
 * Converts Temporal client errors into Norn errors with stable codes and HTTP statuses.
 * Errors it does not recognise are returned unchanged.
 */
export function toNornError(error: unknown, ctx: ErrorContext): unknown {
  if (error instanceof NornError) return error;
  if (error instanceof WorkflowExecutionAlreadyStartedError) {
    return new WorkflowAlreadyStartedError({
      workflowId: error.workflowId ?? ctx.workflowId,
      workflowType: error.workflowType ?? ctx.workflowType,
      cause: error,
    });
  }
  if (error instanceof TemporalWorkflowNotFoundError) {
    return new WorkflowNotFoundError({ workflowId: error.workflowId ?? ctx.workflowId, runId: error.runId ?? ctx.runId, cause: error });
  }
  if (error instanceof WorkflowUpdateFailedError) {
    const cause = error.cause;
    return new UpdateRejectedError({
      workflowId: ctx.workflowId,
      update: ctx.update ?? 'unknown',
      failureType: failureTypeOf(cause),
      message: cause?.message || error.message,
      cause: error,
    });
  }
  if (error instanceof TemporalWorkflowFailedError) {
    return new WorkflowFailedError({
      workflowId: ctx.workflowId,
      failureType: failureTypeOf(error.cause),
      message: error.cause?.message || error.message,
      cause: error,
    });
  }
  if (error instanceof QueryNotRegisteredError || error instanceof QueryRejectedError) {
    return new QueryFailedError({ workflowId: ctx.workflowId, query: ctx.query ?? 'unknown', message: error.message, cause: error });
  }
  const grpc = grpcError(error);
  const code = grpc?.code;
  // RESOURCE_EXHAUSTED is usually rate limiting (retryable), but gRPC also uses it for oversized messages, which never succeed.
  const rateLimited = code === GRPC.RESOURCE_EXHAUSTED && !/larger than max/i.test(grpc?.message ?? '');
  if (code === GRPC.UNAVAILABLE || code === GRPC.DEADLINE_EXCEEDED || rateLimited) {
    return new TemporalUnavailableError({ message: `Temporal is unavailable: ${(error as Error).message}`, cause: error });
  }
  if (ctx.query !== undefined && error instanceof ServiceError) {
    return new QueryFailedError({ workflowId: ctx.workflowId, query: ctx.query, message: error.message, cause: error });
  }
  return error;
}
