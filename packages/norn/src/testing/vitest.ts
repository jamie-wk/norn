import { afterAll, beforeAll } from 'vitest';
import type { Duration, WorkflowClass } from '../core/index.js';
import { createTestEnv, type TestEnv, type TestEnvOptions } from './env.js';

/**
 * Creates one test environment for the current test file: started in `beforeAll`, torn down in
 * `afterAll`. Access it lazily inside tests.
 */
export function useTestEnv(options: TestEnvOptions = {}): TestEnv {
  let env: TestEnv | undefined;
  beforeAll(async () => {
    env = await createTestEnv(options);
  }, 120_000);
  afterAll(async () => {
    await env?.teardown();
  });
  const current = (): TestEnv => {
    if (!env) throw new Error('useTestEnv(): the environment is only available inside tests and hooks');
    return env;
  };
  return {
    get temporal() {
      return current().temporal;
    },
    get client() {
      return current().client;
    },
    get worker() {
      return current().worker;
    },
    get mode() {
      return current().mode;
    },
    workflow: <W extends WorkflowClass>(workflowClass: W) => current().workflow(workflowClass),
    sleep: (duration: Duration) => current().sleep(duration),
    teardown: () => current().teardown(),
    [Symbol.asyncDispose]: () => current().teardown(),
  };
}
