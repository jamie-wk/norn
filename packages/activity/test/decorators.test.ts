import { describe, expect, it } from 'vitest';
import { NornConfigError } from '@norn-ts/core';
import { Activities, Activity, NonRetryable, Service, describeActivities, describeService, token } from '../src/index.ts';

class InvalidCardError extends Error {}
class Db {}
const Mailer = token<{ send(to: string): Promise<void> }>('Mailer');

@Activities({ prefix: 'payments.', inject: [Db] })
class PaymentActivities {
  constructor(private readonly db: Db) {}
  @Activity({ timeout: '1m', retries: 3 })
  @NonRetryable([InvalidCardError])
  async charge(_orderId: string) {
    return this.db;
  }
  @Activity({ name: 'refundCharge', local: true }) async refund() {}
  helper() {}
}

@Activities()
@NonRetryable()
class StrictActivities {
  @Activity() async validate() {}
}

describe('describeActivities', () => {
  it('reads prefix, injection and per-method options', () => {
    const def = describeActivities(PaymentActivities);
    expect(def.className).toBe('PaymentActivities');
    expect(def.prefix).toBe('payments.');
    expect(def.inject).toEqual([Db]);
    expect(def.methods).toEqual([
      { method: 'charge', name: 'payments.charge', options: { timeout: '1m', retries: 3, nonRetryable: ['InvalidCardError'] }, nonRetryable: [InvalidCardError] },
      { method: 'refund', name: 'payments.refundCharge', options: { name: 'refundCharge', local: true }, nonRetryable: undefined },
    ]);
  });

  it('applies a class-level @NonRetryable to every method', () => {
    const def = describeActivities(StrictActivities);
    expect(def.prefix).toBe('');
    expect(def.methods[0]).toMatchObject({ name: 'validate', nonRetryable: true });
  });

  it('rejects classes without @Activities', () => {
    class Plain {}
    expect(() => describeActivities(Plain)).toThrow(/@Activities/);
  });

  it('rejects @Activities classes without @Activity methods', () => {
    @Activities()
    class Empty {}
    expect(() => describeActivities(Empty)).toThrow(/no @Activity methods/);
  });

  it('rejects duplicate registered names', () => {
    @Activities()
    class Dupes {
      @Activity({ name: 'go' }) async a() {}
      @Activity({ name: 'go' }) async b() {}
    }
    expect(() => describeActivities(Dupes)).toThrow(/"go"/);
  });

  it.each([{ retries: -1 }, { timeout: 'soon' }, { name: '' }])('rejects invalid @Activity options %j', (opts) => {
    expect(() => {
      class _A {
        @Activity(opts as never) async x() {}
      }
    }).toThrow(NornConfigError);
  });

  it('rejects @Activity on private or static methods', () => {
    expect(() => {
      class _A {
        @Activity() async #x() {}
      }
    }).toThrow(/private/);
    expect(() => {
      class _A {
        @Activity() static async x() {}
      }
    }).toThrow(/static/);
  });

  it('rejects @NonRetryable with non-class entries', () => {
    expect(() => NonRetryable(['nope' as never])).toThrow(NornConfigError);
  });
});

describe('@Service', () => {
  it('records scope, provided token and injection', () => {
    @Service({ provides: Mailer, scope: 'activity', inject: [Db] })
    class SmtpMailer {
      constructor(_db: Db) {}
      async send() {}
    }
    expect(describeService(SmtpMailer)).toEqual({ className: 'SmtpMailer', provides: Mailer, scope: 'activity', inject: [Db] });
  });

  it('defaults to a singleton that provides itself', () => {
    @Service()
    class Banking {}
    expect(describeService(Banking)).toEqual({ className: 'Banking', provides: Banking, scope: 'singleton', inject: undefined });
  });

  it('rejects unknown scopes', () => {
    expect(() => Service({ scope: 'request' as 'activity' })).toThrow(NornConfigError);
  });
});

describe('token', () => {
  it('creates named, unique tokens', () => {
    const a = token<number>('Port');
    const b = token<number>('Port');
    expect(a.name).toBe('Port');
    expect(a).not.toBe(b);
    expect(() => token('')).toThrow(NornConfigError);
  });
});
