---
title: "@norn-ts/create"
description: Scaffolds a new, runnable Norn project with pnpm create @norn-ts.
sidebar:
  order: 1
---

`@norn-ts/create` creates a new Norn project. Walk through it in the [quickstart](/norn/start/quickstart/).

## Usage

```sh
pnpm create @norn-ts my-app
# or
npm create @norn-ts@latest my-app
cd my-app
pnpm dev
```

The only prerequisite is Node 22.18+. The package manager that ran the command (pnpm, npm, yarn or bun, detected from `npm_config_user_agent`) installs the dependencies and runs `norn gen`.

| Option | What it does |
| --- | --- |
| `<project-name>` | The directory to create. The package is named after its last segment, so `apps/billing` works; `.` uses the current directory. The name must be a valid npm package name: lowercase letters, digits, `-`, `.`, `_` and `~`, starting with a letter or digit, at most 214 characters. |
| `--force` | Write into a directory that is not empty. Files with the same names as the template's are replaced. |
| `--no-install` | Skip installing dependencies and running `norn gen`. |
| `-h`, `--help` | Show the usage. |

Without a project name, the command asks for one when run in a terminal, and otherwise exits with a usage error.

Exit codes: `0` on success, `1` for an invalid name, a directory that is not empty (without `--force`) or a failed install or `norn gen`, and `2` for usage errors (unknown flag, more than one name, no name).

## The project

| Path | What |
| --- | --- |
| `src/workflows/order.workflow.ts` | An order workflow with a signal and a query: charge, wait for a cancellation, maybe refund. |
| `src/activities/payment.activities.ts` | An activity class. |
| `src/services/payment-gateway.ts` | A service injected into the activities, behind a token. |
| `src/worker.ts` | The worker process. |
| `src/order.ts` | A client script that starts, signals and queries orders. |
| `test/order.workflow.test.ts` | Tests with mocked activities on Temporal's time-skipping server. |
| `scripts/dev.ts` | What `pnpm dev` runs. |
| `norn.config.ts`, `tsconfig.json`, `vitest.config.ts` | Configuration. |
| `AGENTS.md`, `.claude/skills/norn/` | Instructions and the Norn agent skill, so coding agents know the framework. See [Using Norn with AI agents](/norn/guides/ai-agents/). |

| Script | What it does |
| --- | --- |
| `pnpm dev` | Starts a local Temporal server on `localhost:7233` (UI on `localhost:8233`, data kept in `.temporal/`) unless `TEMPORAL_ADDRESS` is set or a server is already listening on 7233. Then runs `norn gen`, `norn gen --watch` and the worker, and restarts the worker when you change a file. |
| `pnpm order` | Starts an order. `pnpm order cancel <id>` cancels one; `pnpm order status <id>` queries its status. |
| `pnpm test` | `norn gen`, then the tests. |
| `pnpm typecheck` | `norn gen`, then `tsc --noEmit`. |
| `pnpm gen` | `norn gen`. |

The [tutorial](/norn/tutorial/) grows this project into a full order service.
