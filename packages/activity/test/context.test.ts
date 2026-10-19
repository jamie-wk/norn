import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { NornConfigError } from '@norn/core';
import { activityInfo, getCorrelationId, heartbeat, idempotencyKey, lastHeartbeat, runWithCorrelationId } from '../src/index.ts';

describe('idempotencyKey', () => {
  it('is stable for one scheduled activity across retries', async () => {
    const info = {
      activityId: '7',
      workflowExecution: { workflowId: 'payment-1', runId: 'run-a' },
    };
    const first = await new MockActivityEnvironment({ ...info, attempt: 1 }).run(async () => idempotencyKey());
    const retry = await new MockActivityEnvironment({ ...info, attempt: 3 }).run(async () => idempotencyKey());
    expect(first).toBe('payment-1/run-a/7');
    expect(retry).toBe(first);
  });

  it('accepts a suffix to separate several side effects in one activity', async () => {
    const key = await new MockActivityEnvironment({ activityId: '1', workflowExecution: { workflowId: 'w', runId: 'r' } }).run(
      async () => idempotencyKey('refund'),
    );
    expect(key).toBe('w/r/1/refund');
  });

  it('throws outside an activity', () => {
    expect(() => idempotencyKey()).toThrow(NornConfigError);
  });
});

describe('heartbeats', () => {
  it('records heartbeat details and reads the last ones on retry', async () => {
    const env = new MockActivityEnvironment({ heartbeatDetails: { page: 3 } });
    const seen: unknown[] = [];
    env.on('heartbeat', (d: unknown) => seen.push(d));
    const resumedFrom = await env.run(async () => {
      const last = lastHeartbeat<{ page: number }>();
      heartbeat({ page: (last?.page ?? 0) + 1 });
      return last;
    });
    expect(resumedFrom).toEqual({ page: 3 });
    expect(seen).toEqual([{ page: 4 }]);
  });

  it('returns undefined when there is no previous heartbeat', async () => {
    expect(await new MockActivityEnvironment().run(async () => lastHeartbeat())).toBeUndefined();
  });

  it('exposes activity info', async () => {
    expect(await new MockActivityEnvironment({ activityType: 'payments.charge' }).run(async () => activityInfo().activityType)).toBe(
      'payments.charge',
    );
  });
});

describe('correlation IDs', () => {
  it('is undefined outside a correlation scope and set inside', async () => {
    expect(getCorrelationId()).toBeUndefined();
    await runWithCorrelationId('req-1', async () => {
      await Promise.resolve();
      expect(getCorrelationId()).toBe('req-1');
    });
  });
});
