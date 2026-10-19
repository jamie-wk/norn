// Runs in its own process: the Temporal runtime can only be installed once.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { NornConfigError } from '@norn/core';
import { createLocalEnv } from '../../../tooling/test-support/temporal.ts';
import { bundleWorkflows, createWorker, installRuntime } from '../src/index.ts';
import { registry } from './fixtures/registry.ts';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let env: TestWorkflowEnvironment;
let port: number;
const invalid: unknown[] = [];

beforeAll(async () => {
  port = await freePort();
  invalid.push(...[() => installRuntime({ metricsAddress: 'nope' }), () => installRuntime({ metricsAddress: '::1:9464' }), () => installRuntime({ logLevel: 'LOUD' as never })].map((fn) => {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error;
    }
  }));
  installRuntime({ metricsAddress: `127.0.0.1:${port}`, logLevel: 'WARN' });
  env = await createLocalEnv();
});

afterAll(async () => {
  await env?.teardown();
});

it('exposes Prometheus metrics for a running worker', async () => {
  const worker = await createWorker({
    registry,
    connection: env.nativeConnection,
    handleSignals: false,
    workflowBundle: await bundleWorkflows(registry),
  });
  const running = worker.run();
  try {
    await expect
      .poll(async () => (await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).includes('temporal_'), { timeout: 20_000 })
      .toBe(true);
  } finally {
    await worker.shutdown();
    await running;
  }
});

it('validates options before installing', () => {
  expect(invalid).toHaveLength(3);
  for (const error of invalid) expect(error).toBeInstanceOf(NornConfigError);
});

it('refuses to install the runtime twice, keeping the original reason', () => {
  expect(() => installRuntime()).toThrow(/failed: Runtime singleton has already been installed \(it must run once/);
});

it('accepts bracketed IPv6 metrics addresses', () => {
  // Validation passes, so the error is the second install, not the address.
  expect(() => installRuntime({ metricsAddress: '[::]:9464' })).toThrow(/already been installed/);
});
