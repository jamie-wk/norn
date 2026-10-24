import { afterAll, beforeAll, describe } from 'vitest';
import { createTestEnv, type TestEnv } from '../src/index.ts';
import { clientConformance } from './client-conformance.ts';
import { Counters } from './fixtures/contracts.ts';
import { registry } from './fixtures/registry.ts';

describe('real client conformance', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ registry, mode: 'time-skipping' });
  });
  afterAll(() => env?.[Symbol.asyncDispose]());

  clientConformance(() => ({
    norn: env.client,
    finish: async (counterId) => {
      const counter = env.workflow(Counters).get({ counterId });
      await counter.signal('finish');
      await counter.result();
    },
  }));
});
