import { describe, expect, it } from 'vitest';
import {
  QueryNotRegisteredError,
  QueryRejectedError,
  ServiceError,
  WorkflowFailedError as TemporalWorkflowFailedError,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import {
  ApplicationFailure,
  CancelledFailure,
  RetryState,
  TerminatedFailure,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError as TemporalNotFound,
} from '@temporalio/common';
import {
  QueryFailedError,
  TemporalUnavailableError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
} from '@norn/core';
import { toNornError } from '../src/index.ts';

const status = { UNAVAILABLE: 14, DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, RESOURCE_EXHAUSTED: 8 } as const;
const ctx = { workflowId: 'order-1', workflowType: 'OrderWorkflow' };
const grpc = (code: number, message = 'grpc') => Object.assign(new Error(message), { code, details: message, metadata: {} });

describe('toNornError', () => {
  it('maps duplicate starts to 409 WorkflowAlreadyStartedError', () => {
    const err = toNornError(new WorkflowExecutionAlreadyStartedError('exists', 'order-1', 'OrderWorkflow'), ctx);
    expect(err).toBeInstanceOf(WorkflowAlreadyStartedError);
    expect(err).toMatchObject({ status: 409, workflowId: 'order-1', details: { workflowType: 'OrderWorkflow' } });
  });

  it('maps unknown workflows to 404 WorkflowNotFoundError', () => {
    const err = toNornError(new TemporalNotFound('nope', 'order-1', 'run-1'), ctx);
    expect(err).toBeInstanceOf(WorkflowNotFoundError);
    expect(err).toMatchObject({ status: 404, details: { workflowId: 'order-1', runId: 'run-1' } });
  });

  it('maps validator and handler rejections to 422 UpdateRejectedError', () => {
    const cause = ApplicationFailure.create({ type: 'InvalidItemError', message: 'sku is required' });
    const err = toNornError(new WorkflowUpdateFailedError('update failed', cause), { ...ctx, update: 'addItem' });
    expect(err).toBeInstanceOf(UpdateRejectedError);
    expect(err).toMatchObject({ status: 422, failureType: 'InvalidItemError', message: 'sku is required', update: 'addItem' });
    expect((err as UpdateRejectedError).cause).toBeInstanceOf(WorkflowUpdateFailedError);
  });

  it('maps failed runs to WorkflowFailedError with the failure type', () => {
    const app = ApplicationFailure.create({ type: 'PaymentDeclined', message: 'declined', nonRetryable: true });
    const failed = toNornError(new TemporalWorkflowFailedError('failed', app, RetryState.NON_RETRYABLE_FAILURE), ctx);
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    expect(failed).toMatchObject({ failureType: 'PaymentDeclined', message: 'declined' });

    const terminated = toNornError(new TemporalWorkflowFailedError('terminated', new TerminatedFailure('by ops'), RetryState.NON_RETRYABLE_FAILURE), ctx);
    expect(terminated).toMatchObject({ failureType: 'Terminated' });
    const canceled = toNornError(new TemporalWorkflowFailedError('canceled', new CancelledFailure('stop'), RetryState.NON_RETRYABLE_FAILURE), ctx);
    expect(canceled).toMatchObject({ failureType: 'Cancelled' });
  });

  it('maps query problems to QueryFailedError', () => {
    expect(toNornError(new QueryNotRegisteredError('no such query', 1 as never), { ...ctx, query: 'x' })).toBeInstanceOf(QueryFailedError);
    expect(toNornError(new QueryRejectedError(2 as never), { ...ctx, query: 'x' })).toBeInstanceOf(QueryFailedError);
  });

  it.each([status.UNAVAILABLE, status.DEADLINE_EXCEEDED, status.RESOURCE_EXHAUSTED])('maps gRPC %s to 503 TemporalUnavailableError', (code) => {
    const err = toNornError(new ServiceError('call failed', { cause: grpc(code) }), ctx);
    expect(err).toBeInstanceOf(TemporalUnavailableError);
    expect(err).toMatchObject({ status: 503 });
    expect(toNornError(grpc(code), ctx)).toBeInstanceOf(TemporalUnavailableError);
  });

  it('leaves an oversized message alone: retrying it can never succeed', () => {
    const tooBig = grpc(status.RESOURCE_EXHAUSTED, 'Received message larger than max (5242880 vs. 4194304)');
    const wrapped = new ServiceError('Failed to start Workflow', { cause: tooBig });
    expect(toNornError(wrapped, ctx)).toBe(wrapped);
  });

  it('maps a gRPC NOT_FOUND to WorkflowNotFoundError', () => {
    expect(toNornError(new ServiceError('x', { cause: grpc(status.NOT_FOUND) }), ctx)).toBeInstanceOf(WorkflowNotFoundError);
  });

  it('passes Norn errors and unrelated errors through unchanged', () => {
    const norn = new WorkflowNotFoundError({ workflowId: 'a' });
    expect(toNornError(norn, ctx)).toBe(norn);
    const other = new TypeError('bug');
    expect(toNornError(other, ctx)).toBe(other);
  });
});
