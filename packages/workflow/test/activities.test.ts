import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NornConfigError } from '@norn-ts/core';
import { defineActivities, useActivities } from '../src/index.ts';

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

const payments = defineActivities<Payments>()({
  prefix: 'payments.',
  methods: {
    charge: { timeout: '1m', retry: { initialInterval: '1s', maximumAttempts: 5 } },
    refund: { timeout: '30s', retries: 3 },
    audit: { local: true },
  },
});

beforeEach(() => {
  calls.remote.length = 0;
  calls.local.length = 0;
});

describe('useActivities', () => {
  it('schedules each method under its registered name with the declared options', async () => {
    const pay = useActivities(payments);
    expect(await pay.charge(1)).toBe('payments.charge');
    expect(calls.remote).toEqual([
      { startToCloseTimeout: '60000ms', retry: { initialInterval: '1000ms', maximumAttempts: 5 } },
      { startToCloseTimeout: '30000ms', retry: { maximumAttempts: 4 } },
    ]);
    expect(calls.local).toEqual([{ startToCloseTimeout: '60000ms' }]);
  });

  it('applies shared overrides to every method, then per-method overrides', () => {
    useActivities(payments, { timeout: '5s', methods: { refund: { timeout: '10s' } } });
    expect(calls.remote.map((o) => (o as { startToCloseTimeout: string }).startToCloseTimeout)).toEqual(['5000ms', '10000ms']);
    expect(calls.local).toEqual([{ startToCloseTimeout: '5000ms' }]);
  });

  it('lets an override of retries replace a declared retry.maximumAttempts', () => {
    useActivities(payments, { methods: { charge: { retries: 0 } } });
    expect(calls.remote[0]).toEqual({ startToCloseTimeout: '60000ms', retry: { initialInterval: '1000ms', maximumAttempts: 1 } });
  });

  it('lets an override of retry.maximumAttempts replace declared retries', () => {
    useActivities(payments, { retry: { maximumAttempts: 2 } });
    expect(calls.remote).toEqual([
      { startToCloseTimeout: '60000ms', retry: { maximumAttempts: 2 } },
      { startToCloseTimeout: '30000ms', retry: { maximumAttempts: 2 } },
    ]);
  });

  it('lets a per-method override win over a shared one', () => {
    useActivities(payments, { retries: 1, methods: { refund: { retry: { maximumAttempts: 7 } } } });
    expect(calls.remote[1]).toEqual({ startToCloseTimeout: '30000ms', retry: { maximumAttempts: 7 } });
  });

  it('still rejects retries and retry.maximumAttempts set in the same override', () => {
    expect(() => useActivities(payments, { retries: 1, retry: { maximumAttempts: 2 } })).toThrow(NornConfigError);
  });

  it('rejects anything that is not an activities reference', () => {
    expect(() => useActivities({} as typeof payments)).toThrow(NornConfigError);
  });
});
