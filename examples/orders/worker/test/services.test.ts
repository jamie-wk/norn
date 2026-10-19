// Service tests: the DI container with a fake HTTP layer, no Temporal needed.
import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { createContainer, provide } from '@norn/activity';
import { PaymentActivities } from '../src/activities/payment.activities.ts';
import { AppConfig } from '../src/services/config.ts';
import { HttpClient, HttpError } from '../src/services/http.ts';
import { HttpPaymentGateway, PaymentGateway } from '../src/services/payment-gateway.ts';

function fakeHttp(respond: (path: string, body: unknown, headers: Record<string, string>) => unknown) {
  const calls: Array<{ path: string; body: unknown; headers: Record<string, string> }> = [];
  const http = {
    async post(path: string, body: unknown, headers: Record<string, string> = {}) {
      calls.push({ path, body, headers });
      return respond(path, body, headers);
    },
  } as unknown as HttpClient;
  return { http, calls };
}

const build = (http: HttpClient) =>
  createContainer({
    providers: [provide(AppConfig, () => ({ providerUrl: 'http://x', httpTimeoutMs: 1_000 }))],
    services: [{ cls: HttpPaymentGateway, deps: [HttpClient] }],
    activities: [{ cls: PaymentActivities, deps: [PaymentGateway] }],
    overrides: [[HttpClient, http]],
    errors: { http: true },
  });

describe('PaymentActivities', () => {
  it('charges with the order ID as idempotency key', async () => {
    const { http, calls } = fakeHttp(() => ({ chargeId: 'ch_1', amountCents: 500 }));
    await using container = build(http);
    const acts = await container.activities();
    expect(await new MockActivityEnvironment().run(acts['payments.charge']!, 'o-1', 500, 'tok')).toEqual({ chargeId: 'ch_1', amountCents: 500 });
    expect(calls[0]).toMatchObject({ path: '/charges', headers: { 'idempotency-key': 'charge-o-1' } });
  });

  it('turns a 402 into a non-retryable PaymentDeclinedError', async () => {
    const { http } = fakeHttp(() => {
      throw new HttpError(402, { reason: 'insufficient funds' }, 'declined');
    });
    await using container = build(http);
    const acts = await container.activities();
    const error = await new MockActivityEnvironment().run(acts['payments.charge']!, 'o-1', 500, 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error).toMatchObject({ type: 'PaymentDeclinedError', nonRetryable: true, message: 'insufficient funds' });
  });

  it('keeps 5xx retryable and other 4xx final', async () => {
    for (const [status, nonRetryable] of [[503, false], [400, true], [429, false]] as const) {
      const { http } = fakeHttp(() => {
        throw new HttpError(status, {}, `HTTP ${status}`);
      });
      await using container = build(http);
      const acts = await container.activities();
      const error = await new MockActivityEnvironment().run(acts['payments.refund']!, 'o-1', 'ch_1').catch((e: unknown) => e);
      expect(error, String(status)).toMatchObject({ nonRetryable });
    }
  });
});
