import { describe, expect, it } from 'vitest';
import { defaultPayloadConverter } from '@temporalio/common';
import type { ActivityExecuteInput } from '@temporalio/worker';
import { CORRELATION_HEADER } from '@norn-ts/core';
import { getCorrelationId } from '@norn-ts/activity';
import { getCorrelationId as clientCorrelationId, runWithCorrelationId as clientRun } from '../../client/src/correlation.ts';
import { correlationActivityInterceptor } from '../src/activity-interceptors.ts';

const execute = correlationActivityInterceptor({} as never).inbound!.execute!;
const run = (headers: ActivityExecuteInput['headers']) => execute({ args: [], headers }, async () => getCorrelationId());

describe('correlationActivityInterceptor', () => {
  it('runs the activity with the correlation ID from its header', async () => {
    expect(await run({ [CORRELATION_HEADER]: defaultPayloadConverter.toPayload('req-1') })).toBe('req-1');
  });

  it('runs without one when the header is missing, undecodable or not a string', async () => {
    expect(await run({})).toBeUndefined();
    expect(await run({ [CORRELATION_HEADER]: { metadata: { encoding: new TextEncoder().encode('bogus') } } })).toBeUndefined();
    expect(await run({ [CORRELATION_HEADER]: defaultPayloadConverter.toPayload(42) })).toBeUndefined();
  });
});

describe('the correlation store', () => {
  it('is one store shared by @norn-ts/client and @norn-ts/activity', () => {
    // Each package keeps its own copy so separately installed copies still agree; this pins them together.
    expect(clientRun('shared', () => getCorrelationId())).toBe('shared');
    expect(clientRun('shared', () => clientCorrelationId())).toBe('shared');
  });
});
