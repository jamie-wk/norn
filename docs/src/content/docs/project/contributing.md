---
title: "Contributing"
---

Norn is MIT-licensed and developed at [github.com/jamie-wk/norn](https://github.com/jamie-wk/norn). Issues and pull requests are welcome.

## Setup

You need **Node.js >= 22.18** and **pnpm 10** (the repository is a pnpm workspace; don't use npm or yarn).

```sh
git clone https://github.com/jamie-wk/norn.git
cd norn
pnpm install
```

## Tests first

Write the failing test first, then the code. Cover the happy path **and** the sad paths (invalid input, errors, timeouts) for every change.

## Commands

```sh
pnpm build                     # all packages (tsc -p tsconfig.build.json)
pnpm lint                      # oxlint --deny-warnings
pnpm typecheck
pnpm test                      # unit (vitest project "unit")
pnpm test:integration          # real Temporal dev server / time-skipping server
pnpm check:deps && pnpm check:pack
pnpm docs:build
```

Run one area with `npx vitest run --project unit packages/norn/test/client`.

Integration tests use existing Temporal binaries when `NORN_TEMPORAL_CLI_PATH` / `NORN_TEMPORAL_TEST_SERVER_PATH` are set (for example in a gitignored `.env.test.local`); otherwise the SDK downloads them.

## Changesets

Every change to a published package needs a changeset describing it for the changelog:

```sh
pnpm changeset
```

Commit the generated file in `.changeset/` with your pull request.
