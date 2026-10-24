# Handoff: Norn 2.0

Norn 2.0 cuts the framework down to its core: write workflows and activities as plain, typed classes.
Keep the rules in [CLAUDE.md](./CLAUDE.md): pnpm, TDD, happy + sad paths, no loss of type safety.

## Status (2026-10-24)

| Area | State |
| --- | --- |
| `@norn-ts/norn` | One package with subpath exports (`/workflow`, `/worker`, `/client`, `/testing`, `/vitest`, `/vite`). Unit, type and integration tests pass. |
| `@norn-ts/create` | Starter without codegen. The scaffold test generates it, typechecks it, runs its tests on the time-skipping server and builds it for production. |
| Verified by hand | `pnpm dev` + `pnpm order` (start, cancel, refund); the compiled worker under plain `node`, both bundling at startup and with `NORN_WORKFLOW_BUNDLE`. |
| Docs | 14 pages. `pnpm docs:build` passes, with twoslash and the link validator. |
| Release | `@norn-ts/norn` and `@norn-ts/create` 2.0.0 are on npm. 2.0.1 (`file://` strings for `workflows`, monorepo docs) waits on its version PR. |

Removed in 2.0: `@norn-ts/cli` (codegen, lock file, `schedules sync`, `histories pull`, `bundle`), `@norn-ts/activity` (decorators, DI container), `@norn-ts/codec`, `@norn-ts/hono`, `@norn-ts/eslint-plugin`, the orders example and the e2e suite, `@Schedule`, correlation IDs, the health server, Prometheus/versioning options, `mockActivities()`, `createFakeClient()`, `assertReplays()`. The docs' Recipes page covers HTTP APIs, monorepos, schedules, encryption and tracing with the SDK.

## Maintainer steps

1. Releases: merging to `main` makes the Release workflow push `changeset-release/main`; merging that branch's
   "chore: version packages" PR publishes. Actions can't open that PR until the repo setting "Allow GitHub
   Actions to create and approve pull requests" is on; until then open it by hand
   (`gh pr create --base main --head changeset-release/main --title "chore: version packages"`).
2. Deprecate the old packages on npm, pointing at `@norn-ts/norn` (not done yet):
   `npm deprecate @norn-ts/core "Replaced by @norn-ts/norn"` (and `workflow`, `activity`, `client`, `worker`, `testing`, `cli`, `codec`, `hono`, `eslint-plugin`).

## Design decisions worth keeping

- **No codegen.** Workflows call activities with `useActivities<T>('namespace', options)` and `import type`, so activity code never reaches the sandbox. The worker registers `{ namespace: instance }` as `namespace.<method>`.
- **The workflow class is the contract.** `contractOf(cls)` reads name, task queue, ID template and handler names from the decorators; importing a workflow class in Node is safe (it only tags metadata). Types can't tell signals from queries, so the client checks the kind at call time and throws `NornConfigError` before any network call.
- **The bundle entry.** Temporal runs exported *functions*, so `writeEntry()` writes a 3-line CommonJS entry (in the OS temp dir, atomically, and only when bundling) that wraps each exported class with `implement()` under its workflow type name. Webpack resolves its packages from the project's `node_modules` via `resolve.modules`.
- **Production.** esbuild compiles `src/worker.ts` and `src/workflows/index.ts`; a `.ts` workflows path that's gone after the build falls back to the `.js` next to it. `NORN_WORKFLOW_BUNDLE` skips bundling at startup.
- **Sandbox rule.** `pnpm check:deps` fails if `src/core` or `src/workflow` import Node built-ins, other folders, or packages other than `@temporalio/workflow` / `common`.
- Activity `retries` counts retries **after** the first attempt (`maximumAttempts = retries + 1`).
