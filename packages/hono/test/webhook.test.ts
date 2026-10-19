import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { NornConfigError } from '@norn/core';
import { getCorrelationId } from '@norn/client';
import {
  nornErrorHandler,
  signalAction,
  temporal,
  temporalWebhook,
  updateAction,
  type NornEnv,
  type WebhookAction,
  type WebhookOptions,
} from '../src/index.ts';
import { Payments, Shipments, fakeClient } from './helpers.ts';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Event = { type: string; id: string; amount?: number };

function setup(options: Partial<WebhookOptions<NornEnv>> = {}) {
  const client = fakeClient();
  const a = new Hono<NornEnv>();
  a.use(temporal({ client }));
  a.onError(nornErrorHandler());
  a.post(
    '/hook',
    temporalWebhook<NornEnv>({
      map: (body) => {
        const event = body as Event;
        if (event.type === 'payment.succeeded') return signalAction(Payments, { paymentId: event.id }, 'paid', { amount: event.amount ?? 0 });
        return null;
      },
      ...options,
    }),
  );
  return { app: a, client };
}

const post = (a: Hono<NornEnv>, body: unknown, headers: Record<string, string> = {}) =>
  a.request('/hook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'hook-1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('temporalWebhook: happy paths', () => {
  it('signals the mapped workflow and returns 202', async () => {
    const { app, client } = setup();
    const res = await post(app, { type: 'payment.succeeded', id: 'p1', amount: 42 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(client.calls).toEqual([{ kind: 'signal', workflowType: 'PaymentWorkflow', workflowId: 'payment-p1', name: 'paid', args: [{ amount: 42 }] }]);
  });

  it('uses the signal name from the contract', async () => {
    const { app, client } = setup({ map: () => signalAction(Payments, { paymentId: 'p2' }, 'failed', 'card declined') });
    expect((await post(app, {})).status).toBe(202);
    expect(client.calls[0]).toMatchObject({ name: 'paymentFailed', args: ['card declined'] });
  });

  it('accepts null from map as ignored (202)', async () => {
    const { app, client } = setup();
    const res = await post(app, { type: 'customer.created', id: 'c1' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 0, ignored: 'unmapped' });
    expect(client.calls).toEqual([]);
  });

  it('treats an empty action list like null', async () => {
    const { app } = setup({ map: () => [] });
    expect(await (await post(app, {})).json()).toEqual({ accepted: 0, ignored: 'unmapped' });
  });

  it('sends multiple actions in order, to several workflows', async () => {
    const { app, client } = setup({
      map: async () => [
        signalAction(Payments, { paymentId: 'p3' }, 'paid', { amount: 1 }),
        signalAction(Shipments, { workflowId: 'ship-9' }, 'delivered', '2026-10-19'),
        signalAction(Payments, { paymentId: 'p3' }, 'ping'),
      ],
    });
    const res = await post(app, {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 3 });
    expect(client.calls.map((c) => [c.workflowId, c.name, c.args])).toEqual([
      ['payment-p3', 'paid', [{ amount: 1 }]],
      ['ship-9', 'delivered', ['2026-10-19']],
      ['payment-p3', 'ping', []],
    ]);
  });

  it('accepts plain action objects without the helpers', async () => {
    const action: WebhookAction<typeof Payments> = { workflow: Payments, target: { paymentId: 'p4' }, signal: 'paid', args: [{ amount: 5 }] };
    const { app, client } = setup({ map: () => action });
    expect((await post(app, {})).status).toBe(202);
    expect(client.calls[0]).toMatchObject({ workflowId: 'payment-p4', name: 'paid' });
  });

  it('runs update actions and returns their results', async () => {
    const { app, client } = setup({
      map: () => [signalAction(Payments, { paymentId: 'p5' }, 'ping'), updateAction(Payments, { paymentId: 'p5' }, 'capture', 99)],
    });
    const res = await post(app, {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, results: [null, { captured: 99, workflowId: 'payment-p5' }] });
    expect(client.calls.map((c) => c.kind)).toEqual(['signal', 'update']);
  });

  it('passes the raw body to verify and the parsed body and context to map', async () => {
    const verify = vi.fn(() => true);
    const map = vi.fn((_body: unknown, c: { var: { correlationId: string } }) => {
      expect(c.var.correlationId).toBe('hook-1');
      expect(getCorrelationId()).toBe('hook-1');
      return null;
    });
    const { app } = setup({ verify, map: map as never });
    const raw = '{"type":"x",  "id":"spaced"}';
    await post(app, raw);
    expect(verify).toHaveBeenCalledWith(expect.anything(), raw, expect.any(Uint8Array));
    expect(map.mock.calls[0]![0]).toEqual({ type: 'x', id: 'spaced' });
  });

  it('supports a custom parser (form-encoded webhooks)', async () => {
    const { app, client } = setup({
      parse: (raw) => Object.fromEntries(new URLSearchParams(raw)),
      map: (body) => signalAction(Payments, { paymentId: (body as { id: string }).id }, 'ping'),
    });
    const res = await app.request('/hook', { method: 'POST', body: 'id=form-1&status=ok', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(202);
    expect(client.calls[0]!.workflowId).toBe('payment-form-1');
  });

  it('uses an explicitly passed client without the middleware', async () => {
    const client = fakeClient();
    const a = new Hono();
    a.post('/hook', temporalWebhook({ client, map: () => signalAction(Payments, { paymentId: 'p6' }, 'ping') }));
    const res = await a.request('/hook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    expect(client.calls).toHaveLength(1);
  });
});

describe('temporalWebhook: sad paths', () => {
  it('rejects unverified requests with 401 before parsing or mapping', async () => {
    const map = vi.fn(() => null);
    const { app } = setup({ verify: async () => false, map });
    const res = await post(app, 'not even json');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'WEBHOOK_UNVERIFIED', message: 'Webhook signature verification failed', details: {}, correlationId: 'hook-1' },
    });
    expect(map).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    const { app } = setup();
    for (const body of ['{"type":', '', 'undefined']) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'WEBHOOK_INVALID_BODY', correlationId: 'hook-1' } });
    }
  });

  it('rejects a body the custom parser throws on with 400', async () => {
    const { app } = setup({
      parse: () => {
        throw new Error('bad xml');
      },
    });
    const res = await post(app, '<x/>');
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('bad xml');
  });

  it('ignores a closed workflow by default with 200', async () => {
    const { app } = setup({ map: () => signalAction(Payments, { paymentId: 'closed-1' }, 'ping') });
    const res = await post(app, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: 'closed' });
  });

  it("returns 409 for a closed workflow with onClosed: 'error'", async () => {
    const { app } = setup({ onClosed: 'error', map: () => signalAction(Payments, { paymentId: 'closed-2' }, 'ping') });
    const res = await post(app, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'WORKFLOW_CLOSED', details: { workflowId: 'payment-closed-2', closeStatus: 'COMPLETED' } } });
  });

  it('lets an onClosed function build the response', async () => {
    const onClosed = vi.fn((info: { error: { closeStatus: string }; index: number }, c: { json: (b: unknown, s: number) => Response }) =>
      c.json({ late: info.error.closeStatus, index: info.index }, 200),
    );
    const { app } = setup({ onClosed: onClosed as never, map: () => [signalAction(Payments, { paymentId: 'ok' }, 'ping'), signalAction(Payments, { paymentId: 'closed-3' }, 'ping')] });
    const res = await post(app, {});
    expect(await res.json()).toEqual({ late: 'COMPLETED', index: 1 });
    expect(onClosed.mock.calls[0]![0]).toMatchObject({ action: { target: { paymentId: 'closed-3' } } });
  });

  it('continues when an onClosed function returns nothing', async () => {
    const { app, client } = setup({
      onClosed: () => undefined,
      map: () => [signalAction(Payments, { paymentId: 'closed-4' }, 'ping'), signalAction(Payments, { paymentId: 'open-4' }, 'ping')],
    });
    const res = await post(app, {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, ignored: 1 });
    expect(client.calls.map((c) => c.workflowId)).toEqual(['payment-open-4']);
  });

  it('returns 404 for an unknown workflow by default', async () => {
    const { app } = setup({ map: () => signalAction(Payments, { paymentId: 'missing-1' }, 'ping') });
    const res = await post(app, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'WORKFLOW_NOT_FOUND', details: { workflowId: 'payment-missing-1' }, correlationId: 'hook-1' } });
  });

  it("ignores an unknown workflow with onNotFound: 'ignore'", async () => {
    const { app } = setup({ onNotFound: 'ignore', map: () => signalAction(Payments, { paymentId: 'missing-2' }, 'ping') });
    const res = await post(app, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: 'not_found' });
  });

  it('lets an onNotFound function build the response', async () => {
    const { app } = setup({ onNotFound: (_info, c) => c.text('retry later', 503), map: () => signalAction(Payments, { paymentId: 'missing-3' }, 'ping') });
    const res = await post(app, {});
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('retry later');
  });

  it('stops at the first failing action', async () => {
    const { app, client } = setup({
      map: () => [signalAction(Payments, { paymentId: 'a' }, 'ping'), signalAction(Payments, { paymentId: 'missing-4' }, 'ping'), signalAction(Payments, { paymentId: 'b' }, 'ping')],
    });
    expect((await post(app, {})).status).toBe(404);
    expect(client.calls.map((c) => c.workflowId)).toEqual(['payment-a']);
  });

  it('passes other errors to the app error handler (503 so the provider retries)', async () => {
    const { app } = setup({ map: () => signalAction(Payments, { paymentId: 'down-1' }, 'ping') });
    const res = await post(app, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'TEMPORAL_UNAVAILABLE' } });
  });

  it('passes map errors to the app error handler', async () => {
    const { app } = setup({
      map: () => {
        throw new Error('mapper bug');
      },
    });
    const res = await post(app, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL' } });
  });

  it('rejects malformed actions as configuration errors', async () => {
    const bad = [
      { workflow: {}, target: { workflowId: 'x' }, signal: 'ping', args: [] },
      { workflow: Payments, target: { workflowId: 'x' }, args: [] },
      { workflow: Payments, target: { workflowId: 'x' }, signal: 'ping', update: 'capture', args: [] },
      { workflow: Payments, target: null, signal: 'ping', args: [] },
      { workflow: Payments, target: { workflowId: 'x' }, signal: 'ping', args: 'nope' },
      'not an action',
    ];
    for (const action of bad) {
      const errors: unknown[] = [];
      const a = new Hono<NornEnv>();
      a.use(temporal({ client: fakeClient() }));
      a.onError((err, c) => {
        errors.push(err);
        return c.text('err', 500);
      });
      a.post('/hook', temporalWebhook({ map: () => action as never }));
      expect((await post(a, {})).status).toBe(500);
      expect(errors[0]).toBeInstanceOf(NornConfigError);
    }
  });

  it('fails clearly without a client', async () => {
    const errors: unknown[] = [];
    const a = new Hono();
    a.onError((err, c) => {
      errors.push(err);
      return c.text('err', 500);
    });
    a.post('/hook', temporalWebhook({ map: () => signalAction(Payments, { paymentId: 'x' }, 'ping') }));
    await a.request('/hook', { method: 'POST', body: '{}' });
    expect(errors[0]).toBeInstanceOf(NornConfigError);
    expect((errors[0] as Error).message).toMatch(/temporal\(\) middleware/);
  });

  it('rejects invalid options at creation', () => {
    expect(() => temporalWebhook({} as never)).toThrow(NornConfigError);
    expect(() => temporalWebhook({ map: () => null, onClosed: 'explode' as never })).toThrow(NornConfigError);
    expect(() => temporalWebhook({ map: () => null, onNotFound: 1 as never })).toThrow(NornConfigError);
    expect(() => temporalWebhook({ map: () => null, verify: 'yes' as never })).toThrow(NornConfigError);
  });
});
