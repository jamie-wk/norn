import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Encryption keys are set per process stack; the Compose stack runs one fixed configuration.
const compose = process.env.E2E_TARGET === 'compose';
import { generateKey } from '@norn-ts/codec';
import { CODEC_TOKEN, startStack, type Stack } from '../src/stack.ts';
import { newOrder, waitForStatus } from '../src/helpers.ts';

let stack: Stack;

beforeAll(async () => {
  if (compose) return;
  stack = await startStack({ encryptionKeys: { 'k-2026': generateKey() } });
});

afterAll(async () => {
  await stack?.teardown();
});

const b64 = (bytes: Uint8Array | null | undefined) => Buffer.from(bytes ?? new Uint8Array()).toString('base64');

describe.skipIf(compose)('encrypted payloads', () => {
  it('E15: stores only ciphertext in Temporal while the API and worker see plain data', async () => {
    const order = newOrder({ card: 'tok_secret_card' });
    await stack.api('/orders', { body: order });
    const done = await waitForStatus(stack, order.orderId, 'completed');
    expect(done.totalCents).toBe(3_900);

    const history = await stack.temporal.workflow.getHandle(`order-${order.orderId}`).fetchHistory();
    const raw = JSON.stringify(history.events?.map((e) => e.workflowExecutionStartedEventAttributes?.input ?? e.activityTaskScheduledEventAttributes?.input ?? null));
    const input = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    expect(Buffer.from(input?.metadata?.encoding ?? []).toString()).toBe('binary/encrypted');
    expect(Buffer.from(input?.metadata?.['encryption-key-id'] ?? []).toString()).toBe('k-2026');
    expect(raw).not.toContain('tok_secret_card');
    expect(Buffer.from(input?.data ?? []).toString()).not.toContain('tok_secret_card');
  });

  it('E16: the codec endpoint decodes for authorized callers only', async () => {
    const order = newOrder();
    await stack.api('/orders', { body: order });
    await waitForStatus(stack, order.orderId, 'completed');
    const history = await stack.temporal.workflow.getHandle(`order-${order.orderId}`).fetchHistory();
    const input = history.events![0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!;
    const payload = {
      metadata: Object.fromEntries(Object.entries(input.metadata ?? {}).map(([k, v]) => [k, b64(v)])),
      data: b64(input.data),
    };

    const anonymous = await stack.api('/codec/decode', { body: { payloads: [payload] } });
    expect(anonymous.status).toBe(401);
    const wrong = await stack.api('/codec/decode', { body: { payloads: [payload] }, headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);

    const decoded = await stack.api('/codec/decode', { body: { payloads: [payload] }, headers: { authorization: `Bearer ${CODEC_TOKEN}` } });
    expect(decoded.status).toBe(200);
    const plain = decoded.body.payloads[0];
    expect(Buffer.from(plain.metadata.encoding, 'base64').toString()).toBe('json/plain');
    expect(JSON.parse(Buffer.from(plain.data, 'base64').toString())).toMatchObject({ orderId: order.orderId, email: order.email });

    const garbage = await stack.api('/codec/decode', { body: { payloads: [{ ...payload, data: b64(new Uint8Array([1, 2, 3])) }] }, headers: { authorization: `Bearer ${CODEC_TOKEN}` } });
    expect(garbage.status).toBe(400);
  });
});
