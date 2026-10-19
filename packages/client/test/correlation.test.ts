import { describe, expect, it } from 'vitest';
import { defaultPayloadConverter } from '@temporalio/common';
import { CORRELATION_HEADER } from '@norn-ts/core';
import { correlationInterceptor, getCorrelationId, runWithCorrelationId } from '../src/index.ts';

const interceptor = correlationInterceptor();
const call = async (method: 'start' | 'signal' | 'query' | 'startUpdate' | 'signalWithStart', headers = {}) => {
  let seen: Record<string, unknown> | undefined;
  const next = async (input: { headers: Record<string, unknown> }) => {
    seen = input.headers;
    return undefined as never;
  };
  await (interceptor[method] as (input: unknown, next: unknown) => Promise<unknown>)({ headers }, next);
  return seen;
};

describe('correlationInterceptor', () => {
  it('adds the current correlation ID to outbound calls', async () => {
    for (const method of ['start', 'signal', 'query', 'startUpdate', 'signalWithStart'] as const) {
      const headers = await runWithCorrelationId('req-9', () => call(method));
      expect(defaultPayloadConverter.fromPayload(headers![CORRELATION_HEADER] as never)).toBe('req-9');
    }
  });

  it('leaves headers alone without a correlation ID', async () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(await call('start', { other: 1 })).toEqual({ other: 1 });
  });

  it('does not overwrite an explicit header', async () => {
    const explicit = defaultPayloadConverter.toPayload('explicit');
    const headers = await runWithCorrelationId('req-9', () => call('start', { [CORRELATION_HEADER]: explicit }));
    expect(headers![CORRELATION_HEADER]).toBe(explicit);
  });

  it('shares correlation IDs with other copies through globalThis', async () => {
    const store = (globalThis as Record<symbol, { getStore(): unknown }>)[Symbol.for('norn.correlation')];
    await runWithCorrelationId('shared', async () => expect(store!.getStore()).toBe('shared'));
  });
});
