import { afterAll, beforeAll, vi, type Mock } from 'vitest';
import type { AnyWorkflowContract, Duration } from '@norn-ts/core';
import { createTestEnv, type TestEnv, type TestEnvOptions } from './env.js';
import { buildMocks, type ActivitiesRefLike, type ActivityImpls, type MethodFn, type MockedActivities, type RefInstance } from './mocks.js';

type AnyFn = (...args: any[]) => any;

/**
 * Like `mockActivities()` from `@norn-ts/testing`, but every mock is a `vi.fn()`, so you can use
 * `toHaveBeenCalledWith` and friends.
 */
export function mockActivities<R extends ActivitiesRefLike<any, any>, const I extends ActivityImpls<R>>(
  ref: R,
  impls: I,
): MockedActivities<R, { [K in keyof I]: Mock<MethodFn<RefInstance<R>, K>> }> {
  return buildMocks(ref, impls, (impl) => vi.fn<AnyFn>(impl));
}

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
    workflow: ((target: AnyWorkflowContract) => current().workflow(target)) as TestEnv['workflow'],
    sleep: (duration: Duration) => current().sleep(duration),
    teardown: () => current().teardown(),
    [Symbol.asyncDispose]: () => current().teardown(),
  };
}
