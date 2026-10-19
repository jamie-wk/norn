import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { createLocalEnv, uniqueQueue } from '../../../tooling/test-support/temporal.ts';
import { clientDataConverter, createDataConverter, generateKey } from '../src/index.ts';

const workflowsPath = fileURLToPath(new URL('./fixtures/workflows.ts', import.meta.url));
const keys = { '2026-10': generateKey() };
const currentKeyId = '2026-10';
const dec = new TextDecoder();

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe('encrypted data converter against a real server', () => {
  it('round-trips bigint through an encrypted workflow and stores only ciphertext', async () => {
    const taskQueue = uniqueQueue('codec');
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace ?? 'default',
      taskQueue,
      workflowsPath,
      dataConverter: createDataConverter({ keys, currentKeyId }),
    });
    const client = new Client({
      connection: env.connection,
      namespace: env.namespace ?? 'default',
      dataConverter: clientDataConverter({ keys, currentKeyId }),
    });

    const workflowId = `codec-${taskQueue}`;
    const customer = 'customer-plaintext-marker';
    const result = await worker.runUntil(
      client.workflow.execute('doubleInvoice', {
        taskQueue,
        workflowId,
        args: [{ customer, cents: 12345678901234567890n }],
      }),
    );
    expect(result).toEqual({ customer, cents: 12345678901234567890n, doubled: 24691357802469135780n });

    // A client without the codec sees the server's view: encrypted payloads only.
    const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
    const events = history.events ?? [];
    const input = events[0]?.workflowExecutionStartedEventAttributes?.input?.payloads ?? [];
    const output = events.find((e) => e.workflowExecutionCompletedEventAttributes)?.workflowExecutionCompletedEventAttributes?.result
      ?.payloads ?? [];
    expect(input).toHaveLength(1);
    expect(output).toHaveLength(1);
    for (const payload of [...input, ...output]) {
      expect(dec.decode(payload.metadata!.encoding!)).toBe('binary/encrypted');
      expect(dec.decode(payload.metadata!['encryption-key-id']!)).toBe(currentKeyId);
      const raw = Buffer.from(payload.data!).toString('latin1');
      expect(raw).not.toContain(customer);
      expect(raw).not.toContain('12345678901234567890');
      expect(raw).not.toContain('json/plain');
    }
  });
});
