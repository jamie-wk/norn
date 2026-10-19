export {
  createClient,
  type ClientOptions,
  type HandleTarget,
  type NornClient,
  type SignalOperation,
  type UpdateOperation,
  type WorkflowClient,
  type WorkflowHandle,
  type WorkflowStatus,
  type WorkflowSummary,
} from './client.js';
export { startOptions, toTypedSearchAttributes, resolveWorkflowId, type IfClosed, type IfRunning, type StartOptions } from './options.js';
export { toNornError, failureTypeOf, type ErrorContext } from './errors.js';
export { correlationInterceptor, getCorrelationId, runWithCorrelationId } from './correlation.js';
export {
  NornError,
  QueryFailedError,
  TemporalUnavailableError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowClosedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  isNornError,
  type AnyWorkflowContract,
} from '@norn-ts/core';
