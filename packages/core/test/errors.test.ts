import { describe, expect, it } from 'vitest';
import {
  NornError,
  NornConfigError,
  WorkflowAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowClosedError,
  UpdateRejectedError,
  QueryFailedError,
  WorkflowFailedError,
  TemporalUnavailableError,
  errorTypeOf,
  isNornError,
} from '../src/index.ts';

describe('error classes', () => {
  it('carry a stable code, HTTP status and the original cause', () => {
    const cause = new Error('grpc says no');
    const e = new WorkflowAlreadyStartedError({ workflowId: 'order-1', workflowType: 'OrderWorkflow', cause });
    expect(e).toBeInstanceOf(NornError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('WORKFLOW_ALREADY_STARTED');
    expect(e.status).toBe(409);
    expect(e.workflowId).toBe('order-1');
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('WorkflowAlreadyStartedError');
    expect(e.message).toMatch(/order-1/);
  });

  it.each([
    [new WorkflowNotFoundError({ workflowId: 'x' }), 'WORKFLOW_NOT_FOUND', 404],
    [new WorkflowClosedError({ workflowId: 'x', closeStatus: 'COMPLETED' }), 'WORKFLOW_CLOSED', 409],
    [new UpdateRejectedError({ workflowId: 'x', update: 'addItem', failureType: 'ValidationError', message: 'qty' }), 'UPDATE_REJECTED', 422],
    [new QueryFailedError({ workflowId: 'x', query: 'status', message: 'boom' }), 'QUERY_FAILED', 500],
    [new WorkflowFailedError({ workflowId: 'x', failureType: 'PaymentRejectedError', message: 'declined' }), 'WORKFLOW_FAILED', 500],
    [new TemporalUnavailableError({ message: 'down' }), 'TEMPORAL_UNAVAILABLE', 503],
    [new NornConfigError('bad option'), 'CONFIG', 500],
  ] as const)('%s has code %s and status %d', (err, code, status) => {
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(isNornError(err)).toBe(true);
  });

  it('serializes to a safe JSON shape without the cause', () => {
    const e = new UpdateRejectedError({ workflowId: 'w', update: 'cancel', failureType: 'NotCancellableError', message: 'processing' });
    expect(e.toJSON()).toEqual({
      code: 'UPDATE_REJECTED',
      message: 'processing',
      details: { workflowId: 'w', update: 'cancel', failureType: 'NotCancellableError' },
    });
  });

  it('isNornError rejects plain errors and non-errors', () => {
    expect(isNornError(new Error('x'))).toBe(false);
    expect(isNornError('x')).toBe(false);
    expect(isNornError(undefined)).toBe(false);
  });
});

describe('errorTypeOf', () => {
  class PaymentRejectedError extends Error {}
  class NamedError extends Error {
    override name = 'CustomName';
  }

  it('uses a custom error name when set', () => {
    expect(errorTypeOf(new NamedError('x'))).toBe('CustomName');
  });

  it('falls back to the constructor name for subclasses that keep the default name', () => {
    expect(errorTypeOf(new PaymentRejectedError('x'))).toBe('PaymentRejectedError');
  });

  it('returns Error for plain errors and non-error values', () => {
    expect(errorTypeOf(new Error('x'))).toBe('Error');
    expect(errorTypeOf('boom')).toBe('Error');
    expect(errorTypeOf(null)).toBe('Error');
  });
});
