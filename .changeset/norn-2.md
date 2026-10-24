---
'@norn-ts/norn': major
'@norn-ts/create': major
---

Norn 2.0: one package, no codegen.

- **One package.** `@norn-ts/norn` replaces `@norn-ts/core`, `workflow`, `client`, `worker` and `testing`. Import from `@norn-ts/norn/workflow`, `/client`, `/worker`, `/testing`, `/vitest` and `/vite`.
- **No `norn gen`.** Workflows call activities with `useActivities<PaymentActivities>('payments', { timeout, retries })`, importing the activity class with `import type`. The client takes the workflow class itself: `client.workflow(OrderWorkflow)`.
- **Plain activities.** Activities are plain classes, passed to the worker as instances by namespace: `createWorker({ workflows, activities: { payments: new PaymentActivities(gateway) } })`. Tests pass fakes the same way.
- **Removed:** `@norn-ts/cli` (codegen, lock file, `schedules sync`, `histories pull`, `bundle`), `@norn-ts/activity` (decorators, DI container), `@norn-ts/codec`, `@norn-ts/hono`, `@norn-ts/eslint-plugin`, `@Schedule`, correlation IDs, the worker health server, Prometheus metrics and versioning options, `mockActivities()`, `createFakeClient()` and `assertReplays()`. Use Temporal's own APIs for these, which `workerOptions` and the client's `temporal` property still expose.
