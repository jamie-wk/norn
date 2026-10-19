import { describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { NornConfigError } from '@norn/core';
import { Activities, Activity, NonRetryable, Service, createContainer, provide, token } from '../src/index.ts';

class Db {
  closed = false;
  async query(sql: string) {
    return `db:${sql}`;
  }
}
const Config = token<{ prefix: string }>('Config');
const RequestLog = token<{ id: string; lines: string[] }>('RequestLog');

@Service({ inject: [Db, Config] })
class BankingService {
  constructor(
    readonly db: Db,
    readonly config: { prefix: string },
  ) {}
  async balance(account: string) {
    return `${this.config.prefix}:${await this.db.query(account)}`;
  }
}

interface TransferService {
  send(amount: number): Promise<string>;
}
const TransferService = token<TransferService>('TransferService');

@Service({ provides: TransferService, inject: [BankingService] })
class MoovTransferService implements TransferService {
  constructor(readonly banking: BankingService) {}
  async send(amount: number) {
    return `sent ${amount} after ${await this.banking.balance('acct')}`;
  }
}

class InvalidCardError extends Error {}

@Activities({ prefix: 'payments.', inject: [TransferService] })
class PaymentActivities {
  constructor(private readonly transfers: TransferService) {}
  @Activity() async pay(amount: number) {
    return this.transfers.send(amount);
  }
  @Activity() @NonRetryable([InvalidCardError]) async charge(card: string) {
    if (card === 'bad') throw new InvalidCardError('card declined');
    if (card === 'flaky') throw new Error('timeout');
    return 'charged';
  }
}

@Activities({ prefix: 'audit.', inject: [RequestLog] })
class AuditActivities {
  constructor(private readonly log: { id: string; lines: string[] }) {}
  @Activity() async record(line: string) {
    this.log.lines.push(line);
    return { id: this.log.id, lines: [...this.log.lines] };
  }
}

const baseProviders = () => [
  provide(Db, () => new Db(), { dispose: (db) => void (db.closed = true) }),
  provide(Config, async () => ({ prefix: 'acme' })),
];

describe('createContainer', () => {
  it('resolves services, interface tokens and async factories', async () => {
    await using container = createContainer({
      providers: baseProviders(),
      services: [{ cls: BankingService }, { cls: MoovTransferService }],
    });
    const transfers = await container.resolve(TransferService);
    expect(await transfers.send(5)).toBe('sent 5 after acme:db:acct');
    expect(await container.resolve(TransferService)).toBe(transfers);
  });

  it('builds a flat activity map with prefixes', async () => {
    await using container = createContainer({
      providers: baseProviders(),
      services: [{ cls: BankingService }, { cls: MoovTransferService }],
      activities: [{ cls: PaymentActivities }],
    });
    const acts = await container.activities();
    expect(Object.keys(acts).toSorted()).toEqual(['payments.charge', 'payments.pay']);
    const env = new MockActivityEnvironment();
    expect(await env.run(acts['payments.pay']!, 7)).toBe('sent 7 after acme:db:acct');
  });

  it('prefers generated deps over decorator inject lists', async () => {
    class Plain {
      constructor(readonly db: Db) {}
    }
    await using container = createContainer({ providers: baseProviders(), services: [{ cls: Plain, deps: [Db] }] });
    expect((await container.resolve(Plain)).db).toBeInstanceOf(Db);
  });

  it('reports a missing provider with the dependency path', async () => {
    await using container = createContainer({ providers: [], services: [{ cls: BankingService }] });
    await expect(container.resolve(BankingService)).rejects.toThrow(/No provider for Db.*BankingService/);
  });

  it('rejects dependency cycles at creation', () => {
    const A = token<unknown>('A');
    const B = token<unknown>('B');
    expect(() =>
      createContainer({
        providers: [provide(A, () => 1, { deps: [B] }), provide(B, () => 2, { deps: [A] })],
      }),
    ).toThrow(/cycle: A -> B -> A/);
  });

  it('rejects duplicate providers for one token', () => {
    expect(() => createContainer({ providers: [provide(Db, () => new Db()), provide(Db, () => new Db())] })).toThrow(
      /more than one provider for Db/,
    );
  });

  it('rejects duplicate activity names across classes', () => {
    @Activities({ prefix: 'payments.' })
    class Other {
      @Activity() async pay() {}
    }
    expect(() =>
      createContainer({ providers: baseProviders(), activities: [{ cls: PaymentActivities }, { cls: Other }] }),
    ).toThrow(/payments\.pay.*registered by both/);
  });

  it('rejects singletons that depend on activity-scoped values', async () => {
    @Service({ inject: [RequestLog] })
    class Captive {
      constructor(readonly log: unknown) {}
    }
    expect(() =>
      createContainer({
        providers: [provide(RequestLog, () => ({ id: 'x', lines: [] }), { scope: 'activity' })],
        services: [{ cls: Captive }],
      }),
    ).toThrow(/Captive.*singleton.*activity-scoped RequestLog/);
  });

  it('creates activity-scoped values per execution and disposes them afterwards', async () => {
    const disposed: string[] = [];
    let counter = 0;
    await using container = createContainer({
      providers: [
        provide(RequestLog, (ctx) => ({ id: `${ctx.activity?.activityId}-${++counter}`, lines: [] }), {
          scope: 'activity',
          dispose: (log) => void disposed.push(log.id),
        }),
      ],
      activities: [{ cls: AuditActivities }],
    });
    const acts = await container.activities();
    const env = new MockActivityEnvironment({ activityId: 'a1' });
    const first = await env.run(acts['audit.record']!, 'one');
    const second = await env.run(acts['audit.record']!, 'two');
    expect(first).toEqual({ id: 'a1-1', lines: ['one'] });
    expect(second).toEqual({ id: 'a1-2', lines: ['two'] });
    expect(disposed).toEqual(['a1-1', 'a1-2']);
  });

  it('disposes singletons in reverse creation order', async () => {
    const order: string[] = [];
    const First = token<string>('First');
    const Second = token<string>('Second');
    const container = createContainer({
      providers: [
        provide(First, () => 'first', { dispose: () => void order.push('first') }),
        provide(Second, () => 'second', { deps: [First], dispose: () => void order.push('second') }),
      ],
    });
    await container.resolve(Second);
    await container[Symbol.asyncDispose]();
    expect(order).toEqual(['second', 'first']);
  });

  it('disposes values that implement Symbol.asyncDispose', async () => {
    const dispose = vi.fn();
    const Res = token<{ [Symbol.asyncDispose](): Promise<void> }>('Res');
    const container = createContainer({ providers: [provide(Res, () => ({ [Symbol.asyncDispose]: async () => dispose() }))] });
    await container.resolve(Res);
    await container[Symbol.asyncDispose]();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('applies test overrides', async () => {
    const fakeTransfers: TransferService = { send: async (n) => `fake ${n}` };
    await using container = createContainer({
      providers: baseProviders(),
      services: [{ cls: BankingService }, { cls: MoovTransferService }],
      activities: [{ cls: PaymentActivities }],
      overrides: [[TransferService, fakeTransfers]],
    });
    const acts = await container.activities();
    expect(await new MockActivityEnvironment().run(acts['payments.pay']!, 3)).toBe('fake 3');
  });

  it('refuses to resolve after disposal', async () => {
    const container = createContainer({ providers: baseProviders() });
    await container[Symbol.asyncDispose]();
    await expect(container.resolve(Db)).rejects.toThrow(/disposed/);
  });
});

describe('activity error mapping', () => {
  const build = (options: Parameters<typeof createContainer>[0] = {}) =>
    createContainer({
      providers: [provide(TransferService, () => ({ send: async () => 'ok' }))],
      activities: [{ cls: PaymentActivities }],
      ...options,
    });

  it('marks @NonRetryable errors as non-retryable application failures', async () => {
    await using container = build();
    const acts = await container.activities();
    const error = (await new MockActivityEnvironment().run(acts['payments.charge']!, 'bad').catch((e: unknown) => e)) as ApplicationFailure;
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error.nonRetryable).toBe(true);
    expect(error.type).toBe('InvalidCardError');
    expect(error.message).toBe('card declined');
  });

  it('keeps other errors retryable, typed by class name', async () => {
    await using container = build();
    const acts = await container.activities();
    const error = (await new MockActivityEnvironment().run(acts['payments.charge']!, 'flaky').catch((e: unknown) => e)) as ApplicationFailure;
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error.nonRetryable).toBe(false);
    expect(error.type).toBe('Error');
  });

  it('passes Temporal failures through untouched', async () => {
    const failure = ApplicationFailure.create({ type: 'Custom', message: 'x', nonRetryable: false });
    @Activities()
    class Throws {
      @Activity() @NonRetryable() async go() {
        throw failure;
      }
    }
    await using container = createContainer({ activities: [{ cls: Throws }] });
    const acts = await container.activities();
    expect(await new MockActivityEnvironment().run(acts.go!).catch((e: unknown) => e)).toBe(failure);
  });

  it('maps HTTP 4xx errors to non-retryable when enabled, except 408 and 429', async () => {
    @Activities()
    class Http {
      @Activity() async call(status: number) {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }
    }
    await using container = createContainer({ activities: [{ cls: Http }], errors: { http: true } });
    const acts = await container.activities();
    const run = (status: number) =>
      new MockActivityEnvironment().run(acts.call!, status).catch((e: ApplicationFailure) => e.nonRetryable);
    expect(await run(402)).toBe(true);
    expect(await run(404)).toBe(true);
    expect(await run(408)).toBe(false);
    expect(await run(429)).toBe(false);
    expect(await run(503)).toBe(false);
  });

  it('lets a custom mapper decide', async () => {
    await using container = build({ errors: { map: (e) => ((e as Error).message === 'timeout' ? 'non-retryable' : undefined) } });
    const acts = await container.activities();
    const error = (await new MockActivityEnvironment().run(acts['payments.charge']!, 'flaky').catch((e: unknown) => e)) as ApplicationFailure;
    expect(error.nonRetryable).toBe(true);
  });

  it('rejects activity maps before init when a provider throws', async () => {
    await using container = createContainer({
      providers: [
        provide(TransferService, () => {
          throw new Error('cannot connect');
        }),
      ],
      activities: [{ cls: PaymentActivities }],
    });
    await expect(container.activities()).rejects.toThrow(/cannot connect/);
  });

  it('rejects unknown option combinations', () => {
    expect(() => createContainer({ errors: { http: 'yes' as never } })).toThrow(NornConfigError);
  });
});
