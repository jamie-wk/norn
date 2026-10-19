# Handoff: getting Norn to a publishable 1.0

Written at the point the work moved from a Claude cloud session to Claude Code on the
maintainer's machine. Goal: every feature complete, all tests passing (unit, integration, e2e),
docs published, and the repo ready for the maintainer to run the release. Keep the rules in
[CLAUDE.md](./CLAUDE.md): pnpm, TDD, happy + sad paths, no loss of type safety.

## Status (2026-10-18, Claude Code on the maintainer's Mac)

| Area | State |
| --- | --- |
| All packages | Implemented. Unit, integration and type tests pass. |
| Orders example | Passes unit and time-skipping workflow tests. |
| e2e (`pnpm test:e2e`) | 19/19 against real processes (Temporal CLI 1.9.1 / Server 1.32). |
| Docker Compose e2e | Builds and passes (16 + 3 skipped by design). Image pinned to `temporalio/temporal:1.9.1`. |
| Docs | `pnpm docs:build` passes, no dead links, no `VERIFY` markers. `docs.yml` deploys to Pages. |
| READMEs | Root and every package. `check:pack` passes. |
| Review | Narrow review done (determinism, continue-as-new, codec crypto, hono security); blockers fixed. |

Fixed in this pass: deterministic `pnpm build` order (`tooling/build.mjs`; the `@norn/testing` devDependency cycle
made `pnpm -r` order arbitrary), CLI bin stub (`packages/cli/bin/norn.js`) so the bin links before `dist/` exists,
`nornErrorHandler` sends `HTTPException`s as the JSON error body, `createTestEnv` waits for the dev server's search
attributes and registers them on the time-skipping server, `continueAsNew(() => input)` reads the input after handlers
drain, `codecServer` requires `auth` and `temporalWebhook` requires `verify` (`false` to opt out), both have
`maxBodyBytes` (16 MiB / 1 MiB), `cors: ['*']` never sends credentials, Dockerfile `pnpm deploy` with
`auto-install-peers=false`.

## Deliberately left out of 1.0

- Recipes: ACH payment and self-hosting on AWS ECS/CDK. Links to them were removed; add them back with the pages.
- Per-package reference pages and comparison pages (the READMEs are the API reference; docs link to them).
- `llms-full.txt` (`llms.txt` exists).
- Codec decode passes plaintext through (Temporal convention, documented). An opt-in `rejectPlaintext` could come later.
- Review nits not done: webhook replay protection (documented: use timestamped schemes), the Temporal API polyfill
  note for mixed Node fleets, `drainHandlers` evaluating `run()`'s result before the drain, and updates that keep
  arriving during a drain delaying continue-as-new.

## Remaining: maintainer steps

1. Push and get CI green on GitHub (Node 22/24/26, e2e, compose). CI has never run there.
2. Create or claim the `@norn` npm org (fallback `@nornjs`: rename every package and import); add `NPM_TOKEN` or set up
   trusted publishing for `release.yml`; enable GitHub Pages with "GitHub Actions" as the source; confirm `LICENSE`.
3. `pnpm release` publishes every 1.0.0 package (don't add a changeset for 1.0.0). Tag `v1.0.0` and write release notes.

## Design decisions worth keeping

- Workflow-safe activity references: `.norn/activities.ts` uses `defineActivities<T>()` with `import type`, so
  workflow bundles never include activity code, while `useActivities(ref)` stays fully typed.
- Compile-then-bundle in production (`norn bundle` → `NORN_WORKFLOW_BUNDLE`); type checks happen in `tsc`.
- Contracts (`contract<typeof Cls>()`) give the API full types through `import type` only.
- `@Inject` parameter decorators don't exist in TC39 decorators → `inject: [Tokens]` or constructor types read by `norn gen`.
- `norn.lock.json` blocks renames of workflow types, handlers, activities and task queues unless `--accept-rename`.
- Activity `retries` counts retries **after** the first attempt (`maximumAttempts = retries + 1`).
- Webhooks for closed workflows are acknowledged (200 `{ ignored: 'closed' }`) so providers stop retrying.
