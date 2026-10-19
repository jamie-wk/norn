import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from '@temporalio/client';
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { clientDataConverter, generateKey } from '@norn/codec';
import { createClient, type NornClient } from '@norn/client';
import { CORRELATION_HEADER } from '@norn/core';
import { createLocalEnv, startWorkers, type RunningWorkers } from '../../../tooling/test-support/temporal.ts';
import {
  codecServer,
  hmacSha256Verifier,
  nornErrorHandler,
  signalAction,
  temporal,
  temporalWebhook,
  type JsonPayload,
  type NornEnv,
} from '../src/index.ts';
import { HonoPayments } from './fixtures/contracts.ts';

const workflowsPath = fileURLToPath(new URL('./fixtures/workflows.ts', import.meta.url));
const WEBHOOK_SECRET = 'whsec_integration';
const keys = { '2026-10': generateKey() };

let env: TestWorkflowEnvironment;
let workers: RunningWorkers;
let norn: NornClient;
let app: Hono<NornEnv>;

function buildApp(client: NornClient): Hono<NornEnv> {
  const a = new Hono<NornEnv>();
  a.use(temporal({ client }));
  a.onError(nornErrorHandler({ onError: () => undefined }));

  a.post('/payments', async (c) => {
    const input = await c.req.json<{ paymentId: string; amountCents: number }>();
    const handle = await c.var.norn.workflow(HonoPayments).start(input);
    return c.json({ workflowId: handle.workflowId, runId: handle.runId }, 201);
  });
  a.post('/payments/:paymentId/notes', async (c) => {
    const { note } = await c.req.json<{ note: string }>();
    const count = await c.var.norn.workflow(HonoPayments).get({ paymentId: c.req.param('paymentId') }).update('addNote', note);
    return c.json({ count });
  });
  a.post('/payments/:paymentId/paid', async (c) => {
    await c.var.norn.workflow(HonoPayments).get({ paymentId: c.req.param('paymentId') }).signal('paid', 1);
    return c.body(null, 204);
  });
  a.post(
    '/webhooks/payments',
    temporalWebhook<NornEnv>({
      verify: hmacSha256Verifier({ secret: WEBHOOK_SECRET, header: 'x-signature', prefix: 'sha256=' }),
      map: (body) => {
        const event = body as { type: string; data: { paymentId: string; amountCents: number } };
        if (event.type !== 'payment.succeeded') return null;
        return signalAction(HonoPayments, { paymentId: event.data.paymentId }, 'paid', event.data.amountCents);
      },
    }),
  );
  a.route('/codec', codecServer({ codec: clientDataConverter({ keys, currentKeyId: '2026-10' }).payloadCodecs }));
  return a;
}

beforeAll(async () => {
  env = await createLocalEnv();
  workers = await startWorkers(env, { workflowsPath, taskQueues: ['hono-tests'] });
  norn = createClient({ connection: env.connection, namespace: env.namespace ?? 'default' });
  app = buildApp(norn);
});

afterAll(async () => {
  await workers?.stop();
  await env?.teardown();
});

let n = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${n++}`;

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function postWebhook(event: unknown) {
  const raw = JSON.stringify(event);
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;
  return app.request('/webhooks/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body: raw });
}

describe('routes against a real Temporal server', () => {
  it('starts a workflow (201) and rejects a duplicate start with 409 JSON', async () => {
    const paymentId = uid('p');
    const started = await postJson('/payments', { paymentId, amountCents: 500 }, { 'x-correlation-id': 'dup-check' });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ workflowId: `hono-payment-${paymentId}`, runId: expect.any(String) });

    const dup = await postJson('/payments', { paymentId, amountCents: 500 }, { 'x-correlation-id': 'dup-check' });
    expect(dup.status).toBe(409);
    expect(dup.headers.get('x-correlation-id')).toBe('dup-check');
    expect(await dup.json()).toEqual({
      error: {
        code: 'WORKFLOW_ALREADY_STARTED',
        message: `Workflow hono-payment-${paymentId} is already running`,
        details: { workflowId: `hono-payment-${paymentId}`, workflowType: 'HonoPaymentWorkflow' },
        correlationId: 'dup-check',
      },
    });
    await norn.workflow(HonoPayments).get({ paymentId }).signal('paid', 500);
  });

  it('returns 404 JSON for a signal to an unknown workflow', async () => {
    const paymentId = uid('ghost');
    const res = await postJson(`/payments/${paymentId}/paid`, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'WORKFLOW_NOT_FOUND', details: { workflowId: `hono-payment-${paymentId}` } } });
  });

  it('returns 422 with the failure type for a rejected update, and 200 for a valid one', async () => {
    const paymentId = uid('p');
    await postJson('/payments', { paymentId, amountCents: 100 });
    const invalid = await postJson(`/payments/${paymentId}/notes`, { note: '   ' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: 'UPDATE_REJECTED',
        message: 'note must not be empty',
        details: { workflowId: `hono-payment-${paymentId}`, update: 'addNote', failureType: 'InvalidNoteError' },
      },
    });
    const valid = await postJson(`/payments/${paymentId}/notes`, { note: 'gift wrap' });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ count: 1 });
    await norn.workflow(HonoPayments).get({ paymentId }).signal('paid', 100);
  });

  it('signals the workflow from a verified webhook (202) and ignores a late one (200)', async () => {
    const paymentId = uid('p');
    await postJson('/payments', { paymentId, amountCents: 750 });
    const event = { type: 'payment.succeeded', data: { paymentId, amountCents: 750 } };

    const accepted = await postWebhook(event);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: 1 });
    expect(await norn.workflow(HonoPayments).get({ paymentId }).result()).toEqual({ paymentId, paidCents: 750, notes: [] });

    const late = await postWebhook(event);
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ ignored: 'closed' });

    const forged = await app.request('/webhooks/payments', { method: 'POST', headers: { 'x-signature': 'sha256=00' }, body: JSON.stringify(event) });
    expect(forged.status).toBe(401);

    const unknown = await postWebhook({ type: 'payment.succeeded', data: { paymentId: uid('ghost'), amountCents: 1 } });
    expect(unknown.status).toBe(404);
  });

  it('carries the request correlation ID into the workflow start header', async () => {
    const paymentId = uid('p');
    const res = await postJson('/payments', { paymentId, amountCents: 1 }, { 'x-correlation-id': 'req-from-edge-42' });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe('req-from-edge-42');
    const history = await env.client.workflow.getHandle(`hono-payment-${paymentId}`).fetchHistory();
    const header = history.events?.[0]?.workflowExecutionStartedEventAttributes?.header?.fields?.[CORRELATION_HEADER];
    expect(header && defaultPayloadConverter.fromPayload(header as Payload)).toBe('req-from-edge-42');
    await norn.workflow(HonoPayments).get({ paymentId }).signal('paid', 1);
  });

  it('returns 503 when Temporal is unreachable (client created lazily from options)', async () => {
    const offline = new Hono<NornEnv>();
    const mw = temporal({ address: '127.0.0.1:1', connectTimeout: '1s' });
    offline.use(mw);
    offline.onError(nornErrorHandler({ onError: () => undefined }));
    offline.post('/payments', async (c) => {
      await c.var.norn.workflow(HonoPayments).start({ paymentId: 'never', amountCents: 1 });
      return c.body(null, 201);
    });
    try {
      const res = await offline.request('/payments', { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'TEMPORAL_UNAVAILABLE', correlationId: expect.any(String) } });
    } finally {
      await mw.close();
    }
  });
});

describe('codec server with payloads from a real Temporal client', () => {
  it('decodes the encrypted input of a workflow started with clientDataConverter', async () => {
    const encrypting = new Client({
      connection: env.connection,
      namespace: env.namespace ?? 'default',
      dataConverter: clientDataConverter({ keys, currentKeyId: '2026-10' }),
    });
    const workflowId = uid('encrypted');
    const input = { customerId: 'c-9', amount: 12_345_678_901_234_567_890n };
    // Nothing polls this queue: the workflow only needs to exist so its history holds the payload.
    await encrypting.workflow.start('UnpolledWorkflow', { taskQueue: 'hono-codec-unpolled', workflowId, args: [input] });
    try {
      const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
      const stored = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0] as Payload;
      const asJson: JsonPayload = {
        metadata: Object.fromEntries(Object.entries(stored.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v!).toString('base64')])),
        data: Buffer.from(stored.data!).toString('base64'),
      };
      expect(Buffer.from(asJson.metadata!.encoding!, 'base64').toString()).toBe('binary/encrypted');

      const res = await postJson('/codec/decode', { payloads: [asJson] }, { origin: 'http://localhost:8233', 'x-namespace': env.namespace ?? 'default' });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8233');
      const [decoded] = ((await res.json()) as { payloads: JsonPayload[] }).payloads;
      const payload: Payload = {
        metadata: Object.fromEntries(Object.entries(decoded!.metadata!).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))])),
        data: new Uint8Array(Buffer.from(decoded!.data!, 'base64')),
      };
      expect(Buffer.from(payload.metadata!.encoding!).toString()).toBe('json/plain');
      expect(clientDataConverter().payloadConverter.fromPayload(payload)).toEqual(input);
    } finally {
      await env.client.workflow.getHandle(workflowId).terminate('test cleanup');
    }
  });
});
