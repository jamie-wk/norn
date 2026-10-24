# Norn — notes for Claude Code

Norn is an open-source (MIT, maintained by Jamie King, GitHub `jamie-wk/norn`) decorator-driven
TypeScript framework on top of the Temporal TypeScript SDK 1.24, published as `@norn-ts/*` on npm
(the `norn` and `nornjs` npm orgs are taken; the product, CLI and config are still called Norn). Docs go to https://jamie-wk.github.io/norn/.

**Start with [HANDOFF.md](./HANDOFF.md)**: current status, known failures and the remaining work, in order.

## Project rules (from the maintainer)

- pnpm workspaces (pnpm 10.28). Never npm/yarn.
- TDD: write the failing test first, then the code. Cover happy **and** sad paths; this is going to 1.0.
- TypeScript 7 (`tsc` 7.0.2, no compiler API) and Node >= 22.18 (CI: 22/24/26). Prefer modern
  platform APIs (`using`/`AsyncDisposable`, `AbortSignal.any`, native type stripping, WebCrypto).
- TC39 **standard** decorators only — never `experimentalDecorators`.
- Keep type safety end to end: workflow IDs, handler args/results, search attributes and activity
  signatures are all checked at compile time. Don't loosen types to make something compile.
- Dependency discipline: `@norn-ts/core` has zero runtime deps; `@norn-ts/workflow` depends only on core +
  `@temporalio/workflow|common`; nothing that runs in the workflow sandbox imports Node APIs.
  `pnpm check:deps` enforces this.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Errors (code + HTTP status), durations, ID templates, contracts, `transitions()`, metadata tagging. Workflow-safe. |
| `packages/workflow` | `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate`, `@Schedule`, `implement()`, `useActivities()`, `useChild()`, `useExternal()`, `continueAsNew()`, `asFailure()`, `setSearchAttributes()`. |
| `packages/activity` | `@Activities`, `@Activity`, `@NonRetryable`, `@Service`, `token()`, `provide()`, `createContainer()` (DI), error mapping, activity context helpers, correlation IDs. |
| `packages/client` | `createClient()` → typed `workflow(contract)` client with Norn error mapping, with-start operations, correlation interceptor. |
| `packages/worker` | `createWorker({ registry })`, `bundleWorkflows()`, health server, versioning, `installRuntime()` (Prometheus), interceptors. |
| `packages/testing` | `createTestEnv()`, `mockActivities()`, `createFakeClient()`, `assertReplays()`, `useTestEnv()` (`/vitest`), `standardDecorators()` (`/vite`). |
| `packages/cli` | `norn gen` (syntax-only codegen with oxc-parser → `.norn/`), `schedules sync`, `histories pull`, `bundle`. |
| `packages/codec` | AES-GCM payload encryption with key rotation, Norn JSON payload converter. |
| `packages/hono` | `temporal()` middleware, `nornErrorHandler()`, `temporalWebhook()`, `hmacSha256Verifier()`, `codecServer()`. |
| `packages/eslint-plugin` | `norn/workflow-determinism`, `norn/no-activity-imports`. |
| `examples/orders/*` | Full example: worker, generated contracts, Hono API, scriptable provider stub. |
| `e2e/` | The example as real processes (or Docker Compose) — scenario suite. |
| `packages/create` | `pnpm create @norn-ts`: scaffolds the starter in `template/` (`_gitignore` is renamed on copy; `.claude/skills/norn/SKILL.md` must equal `skills/norn/SKILL.md`, a test checks). |
| `docs/` | Astro Starlight site. `ts twoslash` blocks are type-checked against workspace sources; broken links and render errors fail `pnpm docs:build`. |
| `tooling/` | `check-deps.mjs`, `check-pack.mjs`, `test-support/temporal.ts` (test helpers). |

## Commands

```sh
pnpm install
pnpm build                     # all packages (tsc -p tsconfig.build.json)
pnpm lint                      # oxlint --deny-warnings
pnpm typecheck
pnpm test                      # unit (vitest project "unit")
pnpm test:integration          # real Temporal dev server / time-skipping server
pnpm e2e:build && pnpm test:e2e
pnpm check:deps && pnpm check:pack
pnpm --filter @norn/example-orders-worker gen      # regenerate the example's .norn/
pnpm docs:build
```

Run a single package: `npx vitest run --project unit packages/client`.
Typecheck one package: `cd packages/client && npx tsc -p tsconfig.json --noEmit`.

Integration tests use existing Temporal binaries when `NORN_TEMPORAL_CLI_PATH` /
`NORN_TEMPORAL_TEST_SERVER_PATH` are set (put them in a gitignored `.env.test.local`, which
`vitest.config.ts` loads); otherwise the SDK downloads them. On a Mac, `brew install temporal` and
set `NORN_TEMPORAL_CLI_PATH=$(which temporal)`.

## Gotchas learned the hard way

- Vite 8 / oxc does not lower decorators: tests rely on `standardDecorators()` (esbuild pre-transform) in `vitest.config.ts`.
- The workflow sandbox freezes `Symbol`, so `Symbol.metadata` can't be used; metadata is stored by tagging functions/classes with `Symbol.for('norn.*')` (`packages/core/src/meta.ts`).
- Temporal's bundler needs swc `decoratorVersion: '2022-03'` and `.js`→`.ts` extension aliases: `nornWebpackConfigHook()` in `packages/worker/src/bundler.ts`.
- Temporal registers workflows by **export name**, so the generated barrel's export names must equal workflow type names.
- Workspace packages resolve to `src/*.ts` via the `@norn/source` export condition in dev/tests; published builds use `dist`.
- Node won't strip types inside `node_modules`, so the example API is bundled with esbuild in Docker.
- `WithStartWorkflowOperation` is constructed with `new`, not `.create()`.
