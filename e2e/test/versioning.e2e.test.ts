import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Needs a per-test worker environment; the Compose stack runs one fixed configuration.
const compose = process.env.E2E_TARGET === 'compose';
import { startStack, type Stack } from '../src/stack.ts';
import { newOrder, waitForStatus } from '../src/helpers.ts';

let stack: Stack;

beforeAll(async () => {
  if (compose) return;
  stack = await startStack({ workerEnv: { NORN_DEPLOYMENT_NAME: 'orders', NORN_BUILD_ID: 'v1' } });
});

afterAll(async () => {
  await stack?.teardown();
});

describe.skipIf(compose)('worker deployments', () => {
  it('E14: a versioned worker serves workflows once its build is the current version', async () => {
    await expect
      .poll(async () => {
        try {
          await stack.temporalCli(['worker', 'deployment', 'set-current-version', '--deployment-name', 'orders', '--build-id', 'v1', '--yes']);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 30_000, interval: 1_000 })
      .toBe(true);

    const order = newOrder();
    await stack.api('/orders', { body: order });
    await waitForStatus(stack, order.orderId, 'completed');
    const description = await stack.temporal.workflow.getHandle(`order-${order.orderId}`).describe();
    const versioning = description.raw.workflowExecutionInfo?.versioningInfo;
    expect(versioning?.deploymentVersion?.buildId ?? versioning?.version).toMatch(/v1/);
  });
});
