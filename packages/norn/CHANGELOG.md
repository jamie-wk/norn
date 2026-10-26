# @norn-ts/norn

## 2.0.1

### Patch Changes

- [#8](https://github.com/jamie-wk/norn/pull/8) [`4321a3e`](https://github.com/jamie-wk/norn/commit/4321a3e10ee655e90c688ebf9a8c062063709845) Thanks [@jamie-wk](https://github.com/jamie-wk)! - `@norn-ts/norn/client` no longer exports the undocumented internals `startOptions`, `toTypedSearchAttributes`, `resolveWorkflowId` and `failureTypeOf`. Use `workflow(WorkflowClass).start()` and friends instead; the underlying Temporal client is still available as `client.temporal`.

- [#5](https://github.com/jamie-wk/norn/pull/5) [`8bc49e6`](https://github.com/jamie-wk/norn/commit/8bc49e6261c44d1a29de49011b5a91dd60de78a5) Thanks [@jamie-wk](https://github.com/jamie-wk)! - `createWorker({ workflows })`, `createTestEnv({ workflows })` and `bundleWorkflows()` accept a `file://` URL string, such as `import.meta.resolve('@acme/workflows')` returns. Before, it was read as a relative path and failed. The docs' Recipes page now covers monorepos.

- [#8](https://github.com/jamie-wk/norn/pull/8) [`0d66e6e`](https://github.com/jamie-wk/norn/commit/0d66e6e4ae93bdb7e50b1019051f2d839690078f) Thanks [@jamie-wk](https://github.com/jamie-wk)! - The client rejects `NaN` and `Infinity` for a `double` search attribute, as `setSearchAttributes()` in workflow code already did. Both now share one check.

## 2.0.0

### Major Changes

- [#3](https://github.com/jamie-wk/norn/pull/3) [`c3a4456`](https://github.com/jamie-wk/norn/commit/c3a44561b6f5811a2a718c18d269c6bde65e9b64) Thanks [@jamie-wk](https://github.com/jamie-wk)! - Norn 2.0: one package, no codegen.
  
  - **One package.** `@norn-ts/norn` replaces `@norn-ts/core`, `workflow`, `client`, `worker` and `testing`. Import from `@norn-ts/norn/workflow`, `/client`, `/worker`, `/testing`, `/vitest` and `/vite`.
  - **No `norn gen`.** Workflows call activities with `useActivities<PaymentActivities>('payments', { timeout, retries })`, importing the activity class with `import type`. The client takes the workflow class itself: `client.workflow(OrderWorkflow)`.
  - **Plain activities.** Activities are plain classes, passed to the worker as instances by namespace: `createWorker({ workflows, activities: { payments: new PaymentActivities(gateway) } })`. Tests pass fakes the same way.
  - **Removed:** `@norn-ts/cli` (codegen, lock file, `schedules sync`, `histories pull`, `bundle`), `@norn-ts/activity` (decorators, DI container), `@norn-ts/codec`, `@norn-ts/hono`, `@norn-ts/eslint-plugin`, `@Schedule`, correlation IDs, the worker health server, Prometheus metrics and versioning options, `mockActivities()`, `createFakeClient()` and `assertReplays()`. Use Temporal's own APIs for these, which `workerOptions` and the client's `temporal` property still expose.
