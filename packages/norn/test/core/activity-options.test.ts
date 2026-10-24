import { describe, expect, it } from 'vitest';
import { NornConfigError, toActivityOptions, DEFAULT_ACTIVITY_TIMEOUT } from '../../src/core/index.ts';

describe('toActivityOptions', () => {
  it('maps friendly options to Temporal activity options', () => {
    expect(
      toActivityOptions({ timeout: '1m', heartbeat: '10s', retries: 3, scheduleToClose: '1h', taskQueue: 'payments' }),
    ).toEqual({
      startToCloseTimeout: '60000ms',
      scheduleToCloseTimeout: '3600000ms',
      heartbeatTimeout: '10000ms',
      retry: { maximumAttempts: 4 },
      taskQueue: 'payments',
    });
  });

  it('defaults to a start-to-close timeout when no timeout is given', () => {
    expect(toActivityOptions({})).toEqual({ startToCloseTimeout: `${DEFAULT_ACTIVITY_TIMEOUT}ms` });
  });

  it('keeps a schedule-to-close timeout alone without adding the default', () => {
    expect(toActivityOptions({ scheduleToClose: '5m' })).toEqual({ scheduleToCloseTimeout: '300000ms' });
  });

  it('treats retries: 0 as a single attempt', () => {
    expect(toActivityOptions({ timeout: '5s', retries: 0 }).retry).toEqual({ maximumAttempts: 1 });
  });

  it('merges a full retry policy and non-retryable error types', () => {
    expect(
      toActivityOptions({
        timeout: '5s',
        retry: { initialInterval: '1s', backoffCoefficient: 3, maximumInterval: '1m', maximumAttempts: 10 },
        nonRetryable: ['InvalidCardError'],
      }).retry,
    ).toEqual({
      initialInterval: '1000ms',
      backoffCoefficient: 3,
      maximumInterval: '60000ms',
      maximumAttempts: 10,
      nonRetryableErrorTypes: ['InvalidCardError'],
    });
  });

  it('lets retries win over retry.maximumAttempts only when retry omits it', () => {
    expect(toActivityOptions({ timeout: '1s', retries: 2, retry: { initialInterval: '1s' } }).retry).toEqual({
      initialInterval: '1000ms',
      maximumAttempts: 3,
    });
    expect(() => toActivityOptions({ timeout: '1s', retries: 2, retry: { maximumAttempts: 5 } })).toThrow(NornConfigError);
  });

  it('drops options local activities do not support', () => {
    expect(toActivityOptions({ timeout: '2s', heartbeat: '1s', taskQueue: 'x', local: true })).toEqual({
      startToCloseTimeout: '2000ms',
    });
  });

  it.each([
    { retries: -1 },
    { retries: 1.5 },
    { timeout: 'soon' },
    { retry: { backoffCoefficient: 0.5 } },
    { timeout: 0 },
    { timeout: '0s' },
    { scheduleToClose: 0 },
    { timeout: '1s', scheduleToClose: '0ms' },
    { retry: { maximumAttempts: 0 } },
    { retry: { initialInterval: 0 } },
    { retry: { maximumInterval: '0s' } },
  ])(
    'rejects invalid options %j',
    (opts) => {
      expect(() => toActivityOptions(opts as never)).toThrow(NornConfigError);
    },
  );
});
