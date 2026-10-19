# Handoff: getting Norn to a publishable 1.0

Written at the point the work moved from a Claude cloud session to Claude Code on the
maintainer's machine. Goal: every feature complete, all tests passing (unit, integration, e2e),
docs published, and the repo ready for the maintainer to run the release. Keep the rules in
[CLAUDE.md](./CLAUDE.md): pnpm, TDD, happy + sad paths, no loss of type safety.

## Status

| Area | State |
| --- | --- |
| `@norn/core`, `workflow`, `activity`, `client`, `worker`, `testing`, `codec`, `hono`, `eslint-plugin`, `cli` | Implemented. Unit + integration tests pass against a real dev server. |
| Orders example (`examples/orders`) | Implemented; `.norn/` generated with `norn gen`. Typechecks. 1 unit test and the time-skipping workflow tests fail (see below). |
| e2e suite (`e2e/`) | Written (E1–E18 + webhooks), **never run yet**. |
| Docker Compose e2e, example Dockerfile | Written, **never run** (no Docker where they were written). |
| CI (`.github/workflows/ci.yml`, `release.yml`) | Written, not yet run on GitHub. `docs.yml` still missing. |
| Docs site (`docs/`) | **Partial**: guide pages + 1 recipe written; see "Docs" below. |
| READMEs | cli, codec, eslint-plugin, hono done. **Missing**: root `README.md`, core, workflow, activity, client, worker, testing. `check:pack` fails until they exist. |
| Independent code review | **Not done** (stopped before reporting). |

Unit tests: 650 passing, 1 failing. Last full integration run of `packages/*`: all passing.

## Remaining work, in order

### 1. Fix the known failures

1. **`examples/orders/api/test/app.test.ts` › "returns 409 … 400 for bad bodies"** — the test helper calls
   `res.json()` on hono's `HTTPException` 400 response, which is plain text. Either make the API's
   400s JSON (preferred: send `HTTPException` responses as `{ error: { code: 'BAD_REQUEST', message } }`,
   which `nornErrorHandler` may already support — check `packages/hono/src/errors.ts`) or parse text safely in the helper.
2. **`createTestEnv({ mode: 'time-skipping' })` with search attributes** — `examples/orders/worker/test/order.workflow.int.test.ts`
   fails with `search attribute CustomerId is not defined`, because only `mode: 'local'` registers the
   registry's search attributes (`packages/testing/src/env.ts`). Fix: register them on the time-skipping
   server through the operator service (`temporal.connection.operatorService.addSearchAttributes`) if the
   Java test server supports it; if it doesn't, make `createTestEnv` throw a clear `NornConfigError`
   ("time-skipping mode can't register search attributes; use mode: 'local'") and switch those example tests
   to `local` except where time skipping is the point. Add a test to `packages/testing/test/env.int.test.ts` either way.
3. Uncommitted improvement already in place: `mockActivities()` now types `.calls` by the activity's own
   signature (`packages/testing/src/mocks.ts`, `vitest.ts`). Keep it.

### 2. Run the e2e suite and make it pass

```sh
brew install temporal            # or set NORN_TEMPORAL_CLI_PATH
pnpm e2e:build                   # builds packages, runs norn gen, compiles the worker + bundle
pnpm test:e2e                    # E2E_VERBOSE=1 to stream process logs
```

Unverified assumptions to check first:
- `e2e/src/stack.ts` passes `--dynamic-config-value frontend.workerVersioningWorkflowAPIs=true` and
  `system.enableDeploymentVersions=true` to `temporal server start-dev`. If the server rejects unknown
  keys, drop them (recent dev servers enable deployments by default).
- E14 (`e2e/test/versioning.e2e.test.ts`) uses `temporal worker deployment set-current-version
  --deployment-name … --build-id … --yes`; confirm the flags with `temporal worker deployment set-current-version --help`
  and how `describe().raw.workflowExecutionInfo.versioningInfo` exposes the version.
- E18 matches `norn schedules sync` output with `/created.*daily-sales-report/` and `/unchanged…/`;
  check the real output in `packages/cli/src/schedules.ts`.
- E12 relies on the provider's scripted 4 s shipment delay overlapping a SIGTERM; adjust timings if flaky,
  but keep asserting that the in-flight call finished (status 201) and the worker exited with code 0.
- The API runs with `node src/main.ts` (native type stripping) and imports `@norn/*` from `dist`, so
  `pnpm build` must run first (`e2e:build` does it).

Then try `docker compose -f e2e/docker-compose.yml up -d --build --wait` and `E2E_TARGET=compose pnpm test:e2e`
(security and versioning files skip themselves in compose mode). Pin `temporalio/temporal` to a real
tag if `1.5.1` doesn't exist.

### 3. Finish the docs

Already written: `docs/index.md`, `docs/guide/*` (introduction, getting-started, project-layout,
workflows, messages, activities, dependency-injection, child-workflows, long-running, errors, client,
worker, versioning, testing, encryption, observability, hono, eslint, schedules, cli), `docs/recipes/index.md`,
`docs/recipes/subcontractor-invitation.md`, `docs/.vitepress/config.ts` + `sidebar.mjs`.

Still to do:
- Recipes: **ACH payment from a GC to a subcontractor** (idempotent transfer through an injected
  `TransferService` token, e.g. Moov; settlement wait via a signed webhook → signal; cancel before
  submission; returns/reversals after settlement such as R01 with compensation; notification emails) and
  **self-hosting Temporal on AWS ECS with CDK** for ~30k users with infrequent activity: one RDS Postgres
  instance with two databases (`temporal`, `temporal_visibility`), one ECS service running all server roles
  at first (split later), schema migrations with `temporal-sql-tool` as a one-off task (auto-setup images are
  dev-only), internal NLB/Cloud Map for gRPC 7233, Temporal UI behind auth, workers as their own ECS service
  with health checks on `NORN_HEALTH_PORT` and `stopTimeout` ≥ `NORN_SHUTDOWN_GRACE`, local dev with docker compose.
- Reference: one page per package listing every export with its signature (generate from `src/index.ts`).
- Comparisons: plain Temporal SDK, nestjs-temporal-style libraries, Java/Python/.NET SDK annotations.
- Contributing page, changelog page (points at GitHub releases).
- `docs/public/llms.txt` and `docs/public/llms-full.txt`.
- `.github/workflows/docs.yml`: build on push to main, deploy with `actions/upload-pages-artifact` + `actions/deploy-pages`.
- `grep -rn VERIFY docs/` and reconcile every marker against the code and the package READMEs.
- `pnpm docs:build` must pass with no dead links.

READMEs: root `README.md` (what Norn is, a raw-SDK vs Norn before/after sample, features, install, quick start,
packages table, **"Why the name Norn"** — the Norns Urðr, Verðandi and Skuld weave fate at the well beneath
Yggdrasil: what has been, what is becoming, what shall be; Temporal's history is the past, the running workflow
the present, timers and schedules the future — requirements, links, contributing, license) and one per package for
core, workflow, activity, client, worker, testing. Update `packages/codec/README.md` to mention the edge-safe
`@norn/codec/encryption` entry (the main entry imports `node:url`).

### 4. Independent review

Have a fresh agent (one that didn't write the code) review all of `packages/*/src` for: workflow determinism
(module-level mutable state shared across executions with `reuseV8Context`), handler registration timing,
continue-as-new losing signals, activity option conversion, error mapping for every client operation
(404/409/422/503), DI container races (two activities resolving one singleton at once, failed creation retry,
activity-scope disposal on errors), worker shutdown state machine, codec crypto (nonce, AAD, key rotation),
hono webhook/codec-server security (auth, CORS, body size, raw-byte signatures), and packaging (exports, peers,
Node-only imports in sandbox/edge code). Fix blockers with tests first.

### 5. Release readiness

- `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm check:deps && pnpm check:pack && pnpm gen:check && pnpm docs:build` all green.
- Push to `github.com/jamie-wk/norn` and get CI green (Node 22/24/26, e2e, compose).
- Maintainer steps (can't be automated here): create or claim the `@norn` npm org (fallback `@nornjs` — then rename
  every package and import); add an `NPM_TOKEN` secret or configure npm trusted publishing for `release.yml`;
  enable GitHub Pages with "GitHub Actions" as the source; confirm the copyright holder in `LICENSE` ("Jamie King").
- Publishing: all packages are already at `1.0.0` and in one fixed changesets group. `pnpm release`
  (`pnpm build && changeset publish`) publishes every version not yet on npm — don't add a changeset for 1.0.0.
  Tag `v1.0.0` and write GitHub release notes.

## Design decisions worth keeping

- Workflow-safe activity references: `.norn/activities.ts` uses `defineActivities<T>()` with `import type`, so
  workflow bundles never include activity code, while `useActivities(ref)` stays fully typed.
- Compile-then-bundle in production (`norn bundle` → `NORN_WORKFLOW_BUNDLE`); type checks happen in `tsc`.
- Contracts (`contract<typeof Cls>()`) give the API full types through `import type` only.
- `@Inject` parameter decorators don't exist in TC39 decorators → `inject: [Tokens]` or constructor types read by `norn gen`.
- `norn.lock.json` blocks renames of workflow types, handlers, activities and task queues unless `--accept-rename`.
- Activity `retries` counts retries **after** the first attempt (`maximumAttempts = retries + 1`).
- Webhooks for closed workflows are acknowledged (200 `{ ignored: 'closed' }`) so providers stop retrying.
