# Norn — notes for Claude Code

Norn is an open-source (MIT, maintained by Jamie King, GitHub `jamie-wk/norn`) thin layer of typed
decorators on the Temporal TypeScript SDK 1.24: workflows and activities as plain classes, no codegen.
It's published as one package, `@norn-ts/norn`, plus the scaffolder `@norn-ts/create` (the `norn` and
`nornjs` npm orgs are taken). Docs go to https://jamie-wk.github.io/norn/.

**Start with [HANDOFF.md](./HANDOFF.md)**: current status, known failures and the remaining work, in order.

## Project rules (from the maintainer)

- pnpm workspaces (pnpm 10.28). Never npm/yarn.
- TDD: write the failing test first, then the code. Cover happy **and** sad paths; this is going to 1.0.
- TypeScript 7 (`tsc` 7.0.2, no compiler API) and Node >= 22.18 (CI: 22/24/26). Prefer modern
  platform APIs (`using`/`AsyncDisposable`, `AbortSignal.any`, native type stripping, WebCrypto).
- TC39 **standard** decorators only — never `experimentalDecorators`.
- Keep type safety end to end: workflow IDs, inputs, results, handler args/results and activity
  signatures are all checked at compile time. Don't loosen types to make something compile.
- Keep it small: the point of 2.0 was cutting scope. Prefer documenting an SDK recipe over adding a feature.
- Dependency discipline: `@norn-ts/norn` has no runtime deps (Temporal packages are peers);
  `src/core` and `src/workflow` run in the workflow sandbox and import only each other and
  `@temporalio/workflow|common`. `pnpm check:deps` enforces this.

## Layout

| Path | What |
| --- | --- |
| `packages/norn/src/core` | Errors (code + HTTP status), durations, ID templates, class contracts, activity options, metadata tagging. Workflow-safe. Root export `.` re-exports the public parts. |
| `packages/norn/src/workflow` | `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate`, `implement()`, `contractOf()`, `useActivities<T>(namespace)`, `useChild()`, `useExternal()`, `continueAsNew()`, `asFailure()`, `setSearchAttributes()`. Export `./workflow`. |
| `packages/norn/src/client` | `createClient()` → `workflow(WorkflowClass)` typed client with Norn error mapping and with-start operations. Export `./client`. |
| `packages/norn/src/worker` | `createWorker({ workflows, activities })`, `loadWorkflows()` (task queues), `writeEntry()` (bundle entry), `bundleWorkflows()`, webpack hook. Export `./worker`. |
| `packages/norn/src/testing` | `createTestEnv()` (`./testing`), `useTestEnv()` (`./vitest`), `standardDecorators()` (`./vite`). |
| `packages/norn/test/<area>` | Tests per area; `fixtures/` hold workflow classes and plain activity classes. |
| `packages/create` | `pnpm create @norn-ts`: scaffolds the starter in `template/` (`_gitignore` is renamed on copy; `.claude/skills/norn/SKILL.md` must equal `skills/norn/SKILL.md`, a test checks). |
| `docs/` | Astro Starlight site. `ts twoslash` blocks are type-checked against workspace sources; broken links and render errors fail `pnpm docs:build`. |
| `tooling/` | `check-deps.mjs`, `check-pack.mjs`, `test-support/temporal.ts` (test helpers). |

## Commands

```sh
pnpm install
pnpm build                     # packages (tsc -p tsconfig.build.json)
pnpm lint                      # oxlint --deny-warnings
pnpm typecheck
pnpm test                      # unit (vitest project "unit")
pnpm test:integration          # real Temporal dev server / time-skipping server
pnpm check:deps && pnpm check:pack
pnpm docs:build
```

Run one area: `npx vitest run --project unit packages/norn/test/client`.
Typecheck: `npx tsc -p packages/norn/tsconfig.json --noEmit`. The scaffold integration test uses the *built* package, so run `pnpm build` first.

Integration tests use existing Temporal binaries when `NORN_TEMPORAL_CLI_PATH` /
`NORN_TEMPORAL_TEST_SERVER_PATH` are set (put them in a gitignored `.env.test.local`, which
`vitest.config.ts` loads); otherwise the SDK downloads them. On a Mac, `brew install temporal` and
set `NORN_TEMPORAL_CLI_PATH=$(which temporal)`.

## Gotchas learned the hard way

- Vite 8 / oxc does not lower decorators: tests rely on `standardDecorators()` (esbuild pre-transform) in `vitest.config.ts`.
- The workflow sandbox freezes `Symbol`, so `Symbol.metadata` can't be used; metadata is stored by tagging functions/classes with `Symbol.for('norn.*')` (`packages/norn/src/core/meta.ts`).
- Temporal's bundler needs swc `decoratorVersion: '2022-03'` and `.js`→`.ts` extension aliases: `nornWebpackConfigHook()` in `packages/norn/src/worker/bundler.ts`.
- Temporal runs workflows by **export name** and calls them as functions, so `writeEntry()` (in `load.ts`) writes an entry that wraps each class with `implement()` and exports it under its type name.
- Node can't run decorators (type stripping doesn't lower them): dev uses tsx, builds use esbuild `--target=node22`, Vitest uses `standardDecorators()`.
- The macOS temp dir is a symlink and webpack resolves realpaths, so the bundle entry path goes through `realpath()`.
- The package resolves to `src/*.ts` via the `@norn/source` export condition in dev/tests; published builds use `dist`.
- `WithStartWorkflowOperation` is constructed with `new`, not `.create()`.
