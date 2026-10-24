import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NornConfigError } from '../../src/core/index.ts';
import { useActivities } from '../../src/workflow/index.ts';

const calls = vi.hoisted(() => ({ remote: [] as unknown[], local: [] as unknown[] }));
vi.mock('@temporalio/workflow', async (importOriginal) => {
  const proxy = () => new Proxy({}, { get: (_t, type) => async () => type });
  return {
    ...(await importOriginal<object>()),
    proxyActivities: (options: unknown) => (calls.remote.push(options), proxy()),
    proxyLocalActivities: (options: unknown) => (calls.local.push(options), proxy()),
  };
});

interface Payments {
  charge(amount: number): Promise<string>;
  refund(id: string): Promise<void>;
  audit(id: string): Promise<void>;
}

beforeEach(() => {
  calls.remote.length = 0;
  calls.local.length = 0;
});

describe('useActivities', () => {
  it('schedules <namespace>.<method> with the shared options, created on first use', async () => {
    const pay = useActivities<Payments>('payments', { timeout: '1m', retry: { initialInterval: '1s', maximumAttempts: 5 } });
    expect(calls.remote).toEqual([]);
    expect(await pay.charge(1)).toBe('payments.charge');
    expect(pay.charge).toBe(pay.charge);
    expect(calls.remote).toEqual([{ startToCloseTimeout: '60000ms', retry: { initialInterval: '1000ms', maximumAttempts: 5 } }]);
  });

  it('applies per-method options on top of the shared ones, including local activities', async () => {
    const pay = useActivities<Payments>('payments', { timeout: '5s', methods: { refund: { timeout: '10s', retries: 3 }, audit: { local: true } } });
    await pay.charge(1);
    await pay.refund('x');
    await pay.audit('x');
    expect(calls.remote).toEqual([{ startToCloseTimeout: '5000ms' }, { startToCloseTimeout: '10000ms', retry: { maximumAttempts: 4 } }]);
    expect(calls.local).toEqual([{ startToCloseTimeout: '5000ms' }]);
  });

  it('lets a per-method retries replace a shared retry.maximumAttempts', async () => {
    const pay = useActivities<Payments>('payments', { retry: { initialInterval: '1s', maximumAttempts: 5 }, methods: { charge: { retries: 0 } } });
    await pay.charge(1);
    expect(calls.remote[0]).toEqual({ startToCloseTimeout: '60000ms', retry: { initialInterval: '1000ms', maximumAttempts: 1 } });
  });

  it('passes non-retryable error types to the retry policy', async () => {
    await useActivities<Payments>('payments', { nonRetryable: ['CardDeclinedError'] }).charge(1);
    expect(calls.remote[0]).toEqual({ startToCloseTimeout: '60000ms', retry: { nonRetryableErrorTypes: ['CardDeclinedError'] } });
  });

  it('rejects retries and retry.maximumAttempts together when the method is used', () => {
    const pay = useActivities<Payments>('payments', { retries: 1, retry: { maximumAttempts: 2 } });
    expect(() => pay.charge).toThrow(NornConfigError);
  });

  it('rejects an empty namespace', () => {
    expect(() => useActivities<Payments>('')).toThrow(NornConfigError);
  });

  it('is not a thenable, so it can be returned from async code', () => {
    expect((useActivities<Payments>('payments') as { then?: unknown }).then).toBeUndefined();
  });
});
