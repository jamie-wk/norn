---
title: "Changelog & upgrading"
---

Release notes for every version are on [GitHub Releases](https://github.com/jamie-wk/norn/releases), and in [`packages/norn/CHANGELOG.md`](https://github.com/jamie-wk/norn/blob/main/packages/norn/CHANGELOG.md), generated from [changesets](/norn/project/contributing/#changesets).

## Upgrading from 1.x

Norn 2 replaces the `@norn-ts/*` packages with one, `@norn-ts/norn`, and drops codegen.

1. **Packages.** Remove `@norn-ts/core`, `workflow`, `activity`, `client`, `worker`, `testing`, `cli`, `codec`, `hono` and `eslint-plugin`, and add `@norn-ts/norn`. Imports move to `@norn-ts/norn/workflow`, `/client`, `/worker`, `/testing`, `/vitest` and `/vite`.
2. **Activities.** Remove `@Activities`, `@Activity`, `@NonRetryable` and `@Service`. Move each method's options to the workflow: `useActivities<PaymentActivities>('payments', { timeout, retries, nonRetryable, methods })`, with `import type` for the class. The namespace is the old prefix without its trailing dot. Build your services with constructors.
3. **Workflows.** Replace `.norn/activities` imports with `import type` from the activity file. Add `src/workflows/index.ts` exporting every workflow class.
4. **Worker.** `createWorker({ registry })` becomes `createWorker({ workflows: new URL('./workflows/index.ts', import.meta.url), activities: { payments: new PaymentActivities(gateway) } })`.
5. **Client.** Pass the workflow class instead of the generated contract: `norn.workflow(OrderWorkflow)`.
6. **Tests.** `useTestEnv({ registry, activities: mockActivities(...) })` becomes `useTestEnv({ workflows, activities: { payments: { charge: vi.fn(...) } } })`.
7. **Clean up.** Delete `.norn/`, `norn.config.ts`, `norn.lock.json` and the `gen` scripts.

Activity names stay `<namespace>.<method>`, so in-flight executions keep working as long as the namespaces match the old prefixes and no `@Activity({ name })` renamed a method.
