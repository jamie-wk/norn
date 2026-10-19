import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ServiceError } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError as TemporalWorkflowNotFoundError } from '@temporalio/common';
import {
  NornConfigError,
  NornError,
  QueryFailedError,
  TemporalUnavailableError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowClosedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
} from '@norn/core';
import { nornErrorHandler, temporal, type NornEnv, type NornErrorHandlerOptions } from '../src/index.ts';
import { fakeClient } from './helpers.ts';

function appThrowing(error: unknown, options?: NornErrorHandlerOptions, withMiddleware = true) {
  const a = new Hono<NornEnv>();
  if (withMiddleware) a.use(temporal({ client: fakeClient() }));
  a.get('/', () => {
    throw error;
  });
  a.onError(nornErrorHandler(options));
  return a;
}

// The default onError logs unexpected errors; keep test output clean.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const call = (a: Hono<NornEnv>, id = 'err-corr') => a.request('/', { headers: { 'x-correlation-id': id } });

describe('nornErrorHandler: Norn errors', () => {
  const cases: [string, NornError, number, Record<string, unknown>][] = [
    ['WORKFLOW_ALREADY_STARTED', new WorkflowAlreadyStartedError({ workflowId: 'w1', workflowType: 'T' }), 409, { workflowId: 'w1', workflowType: 'T' }],
    ['WORKFLOW_NOT_FOUND', new WorkflowNotFoundError({ workflowId: 'w2', runId: 'r2' }), 404, { workflowId: 'w2', runId: 'r2' }],
    ['WORKFLOW_CLOSED', new WorkflowClosedError({ workflowId: 'w3', closeStatus: 'COMPLETED' }), 409, { workflowId: 'w3', closeStatus: 'COMPLETED' }],
    [
      'UPDATE_REJECTED',
      new UpdateRejectedError({ workflowId: 'w4', update: 'addItem', failureType: 'InvalidItemError', message: 'sku is required' }),
      422,
      { workflowId: 'w4', update: 'addItem', failureType: 'InvalidItemError' },
    ],
    ['QUERY_FAILED', new QueryFailedError({ workflowId: 'w5', query: 'q', message: 'no such query' }), 500, { workflowId: 'w5', query: 'q' }],
    ['WORKFLOW_FAILED', new WorkflowFailedError({ workflowId: 'w6', failureType: 'Declined', message: 'card declined' }), 500, { workflowId: 'w6', failureType: 'Declined' }],
    ['TEMPORAL_UNAVAILABLE', new TemporalUnavailableError({ message: 'Temporal is unavailable' }), 503, {}],
    ['CONFIG', new NornConfigError('bad config'), 500, {}],
    ['PAYMENT_REQUIRED', new NornError('PAYMENT_REQUIRED', 402, 'pay up', { details: { plan: 'pro' } }), 402, { plan: 'pro' }],
  ];

  it.each(cases)('maps %s', async (code, error, status, details) => {
    const res = await call(appThrowing(error));
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-correlation-id')).toBe('err-corr');
    expect(await res.json()).toEqual({ error: { code, message: error.message, details, correlationId: 'err-corr' } });
  });

  it('never leaks stack or cause', async () => {
    const error = new WorkflowFailedError({ workflowId: 'w', failureType: 'X', message: 'm', cause: new Error('secret cause') });
    const text = await (await call(appThrowing(error))).text();
    expect(text).not.toContain('secret cause');
    expect(text).not.toContain('stack');
  });

  it('applies per-code status overrides', async () => {
    const options = { status: { WORKFLOW_CLOSED: 410, TEMPORAL_UNAVAILABLE: 502 } };
    expect((await call(appThrowing(new WorkflowClosedError({ workflowId: 'w', closeStatus: 'FAILED' }), options))).status).toBe(410);
    expect((await call(appThrowing(new TemporalUnavailableError({ message: 'x' }), options))).status).toBe(502);
    expect((await call(appThrowing(new WorkflowNotFoundError({ workflowId: 'w' }), options))).status).toBe(404);
  });

  it('rejects invalid status overrides at creation', () => {
    expect(() => nornErrorHandler({ status: { WORKFLOW_CLOSED: 99 } })).toThrow(NornConfigError);
    expect(() => nornErrorHandler({ status: { WORKFLOW_CLOSED: 600 } })).toThrow(NornConfigError);
    expect(() => nornErrorHandler({ status: { WORKFLOW_CLOSED: 404.5 } })).toThrow(NornConfigError);
    expect(() => nornErrorHandler({ status: { WORKFLOW_CLOSED: 204 } })).toThrow(NornConfigError);
  });

  it('falls back to 500 for a NornError with an unusable status', async () => {
    const res = await call(appThrowing(new NornError('ODD', 42, 'odd')));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'ODD', message: 'odd' } });
  });
});

describe('nornErrorHandler: raw Temporal errors', () => {
  it('maps an unmapped already-started error to 409', async () => {
    const res = await call(appThrowing(new WorkflowExecutionAlreadyStartedError('already', 'wf-9', 'OrderWorkflow')));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'WORKFLOW_ALREADY_STARTED', details: { workflowId: 'wf-9', workflowType: 'OrderWorkflow' } } });
  });

  it('maps an unmapped not-found error to 404', async () => {
    const res = await call(appThrowing(new TemporalWorkflowNotFoundError('gone', 'wf-1', undefined)));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'WORKFLOW_NOT_FOUND', details: { workflowId: 'wf-1' } } });
  });

  it('maps gRPC UNAVAILABLE to 503', async () => {
    const grpc = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    const res = await call(appThrowing(new ServiceError('Failed to start Workflow', { cause: grpc })));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'TEMPORAL_UNAVAILABLE' } });
  });
});

describe('nornErrorHandler: other errors', () => {
  it('returns hono HTTPException responses unchanged, plus the correlation header', async () => {
    const res = await call(appThrowing(new HTTPException(401, { message: 'nope' })));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('nope');
    expect(res.headers.get('x-correlation-id')).toBe('err-corr');
  });

  it('keeps a custom HTTPException response', async () => {
    const custom = new Response('teapot', { status: 418, headers: { 'x-custom': 'yes' } });
    const res = await call(appThrowing(new HTTPException(418, { res: custom })));
    expect(res.status).toBe(418);
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(res.headers.get('x-correlation-id')).toBe('err-corr');
    expect(await res.text()).toBe('teapot');
  });

  it('hides unknown error messages by default', async () => {
    const res = await call(appThrowing(new Error('db password is hunter2')));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('hunter2');
    expect(JSON.parse(body)).toEqual({ error: { code: 'INTERNAL', message: 'Internal Server Error', details: {}, correlationId: 'err-corr' } });
  });

  it('exposes unknown error messages with expose: true', async () => {
    const res = await call(appThrowing(new TypeError('x is not a function'), { expose: true }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL', message: 'x is not a function', details: {}, correlationId: 'err-corr' } });
  });

  it('decides exposure per error with a function', async () => {
    const expose = vi.fn((err: unknown) => err instanceof RangeError);
    expect(await (await call(appThrowing(new RangeError('out of range'), { expose }))).json()).toMatchObject({ error: { message: 'out of range' } });
    expect(await (await call(appThrowing(new Error('private'), { expose }))).json()).toMatchObject({ error: { message: 'Internal Server Error' } });
    expect(expose).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error throwables', async () => {
    const a = new Hono<NornEnv>();
    a.use(temporal({ client: fakeClient() }));
    a.get('/', () => Promise.reject(new Error('rejected')));
    a.onError(nornErrorHandler());
    expect((await call(a)).status).toBe(500);
  });
});

describe('nornErrorHandler: hooks', () => {
  it('calls onError with the original error and context', async () => {
    const onError = vi.fn();
    const original = new Error('kaboom');
    await call(appThrowing(original, { onError }));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBe(original);
    expect(onError.mock.calls[0]![1].var.correlationId).toBe('err-corr');
  });

  it('awaits async onError and survives one that throws', async () => {
    const order: string[] = [];
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('logged');
    };
    const res = await call(appThrowing(new Error('x'), { onError: slow }));
    order.push('responded');
    expect(order).toEqual(['logged', 'responded']);
    expect(res.status).toBe(500);

    const broken = await call(
      appThrowing(new WorkflowNotFoundError({ workflowId: 'w' }), {
        onError: () => {
          throw new Error('logger down');
        },
      }),
    );
    expect(broken.status).toBe(404);
  });

  it('lets format build the response from the normalized error', async () => {
    const format = vi.fn((err: NornError, c: { json: (b: unknown, s: number) => Response }) => c.json({ problem: err.code, status: err.status }, 418 as never));
    const res = await call(appThrowing(new WorkflowClosedError({ workflowId: 'w', closeStatus: 'COMPLETED' }), { format: format as never }));
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ problem: 'WORKFLOW_CLOSED', status: 409 });
    expect(res.headers.get('x-correlation-id')).toBe('err-corr');

    const unknown = await call(appThrowing(new Error('raw'), { format: format as never }));
    expect(await unknown.json()).toEqual({ problem: 'INTERNAL', status: 500 });
    const normalized = format.mock.calls[1]![0];
    expect(normalized).toBeInstanceOf(NornError);
    expect((normalized.cause as Error).message).toBe('raw');
  });

  it('passes the status override to format', async () => {
    const res = await call(
      appThrowing(new WorkflowClosedError({ workflowId: 'w', closeStatus: 'COMPLETED' }), {
        status: { WORKFLOW_CLOSED: 410 },
        format: (err, c, info) => c.json({ own: err.status, status: info.status, body: info.body, original: info.original === err }, info.status as never),
      }),
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      own: 409,
      status: 410,
      original: true,
      body: { error: { code: 'WORKFLOW_CLOSED', message: 'Workflow w is already closed (COMPLETED)', details: { workflowId: 'w', closeStatus: 'COMPLETED' }, correlationId: 'err-corr' } },
    });
  });

  it('adds the correlation header to format responses without the middleware', async () => {
    const res = await appThrowing(new Error('x'), { format: () => new Response('plain', { status: 500 }) }, false).request('/');
    expect(await res.text()).toBe('plain');
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs unexpected errors with console.error by default, and only those', async () => {
    const spy = vi.mocked(console.error);
    const unexpected = new Error('unexpected');
    await call(appThrowing(unexpected));
    await call(appThrowing(new WorkflowNotFoundError({ workflowId: 'w' })));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(unexpected);
  });
});

describe('nornErrorHandler: correlation IDs without the middleware', () => {
  it('generates and returns a correlation ID', async () => {
    const res = await appThrowing(new WorkflowNotFoundError({ workflowId: 'w' }), undefined, false).request('/');
    const id = res.headers.get('x-correlation-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toMatchObject({ error: { correlationId: id } });
  });

  it('uses a custom correlation header', async () => {
    const a = new Hono<NornEnv>();
    a.use(temporal({ client: fakeClient(), correlationHeader: 'x-trace' }));
    a.get('/', () => {
      throw new WorkflowNotFoundError({ workflowId: 'w' });
    });
    a.onError(nornErrorHandler({ correlationHeader: 'x-trace' }));
    const res = await a.request('/', { headers: { 'x-trace': 't-1' } });
    expect(res.headers.get('x-trace')).toBe('t-1');
    expect(await res.json()).toMatchObject({ error: { correlationId: 't-1' } });
  });
});
