---
title: Codegen & .norn/
description: Why Norn generates code, how norn gen reads your decorators without running them, and what each generated file is for.
---

You write decorated classes. `norn gen` reads them and writes the glue into `.norn/`: the files that the worker, the workflow sandbox and your API each import. This page explains why that step exists. [Project layout & codegen](/norn/guides/project-layout/) shows every generated file in full.

## Why generate code

**Decorators can't produce types or files.** A TC39 decorator is a function that runs when its class is defined. It can attach metadata at runtime, but it can't change the class's type or write a module. Its metadata only exists after something imports the class. Norn needs the opposite: API code that knows a workflow's names and types without loading the workflow.

**The sandbox must not load activity code.** Workflows run in the [workflow sandbox](/norn/concepts/determinism/), bundled apart from the rest of the worker. If a workflow imported your activity class, the bundle would pull in the activity, its services and their Node dependencies. A workflow needs an activity's name, options and signature, never its body. So `norn gen` writes those as plain data, with the class imported as a type only.

**Temporal registers workflows by export name.** A worker finds workflow functions by the export names of its workflows module, and that name is the workflow type clients start. So the generated workflows module must export each workflow under exactly its type name.

## What `norn gen` writes, and who imports it

```text
 src/workflows/*.workflow.ts ──┐
 src/activities/*.ts ──────────┼──► norn gen ──► .norn/
 src/services/*.ts ────────────┘   (parses,         │
                                    never runs)     │
     ┌──────────────────────┬───────────────────────┼──────────────────────┐
     ▼                      ▼                       ▼                      ▼
 workflows.ts          activities.ts          registry.ts            contracts.ts
 bundle entry          imported by your       (+ container.ts)       imported by API
 for the sandbox       workflow files         imported by the        code and clients
                                              worker and tests
```

| File | What it holds | Imported by |
| --- | --- | --- |
| `workflows.ts` | Each workflow class wrapped with `implement()`, exported under its workflow type name | The worker's workflow bundle (through `registry.workflowsPath`) |
| `activities.ts` | One reference per `@Activities` class: registered names and options, with the class as `import type` | Your workflow files, passed to `useActivities()` |
| `contracts.ts` | One contract per workflow, typed from the class through `import type` | API code, `createClient()`, tests. See [Contracts](/norn/concepts/contracts/) |
| `container.ts` | `createNornContainer()`, which wires your activities, services and providers | `registry.ts` |
| `registry.ts` | `registry`: the bundle path, task queues, activity names, search attributes and container | `createWorker()`, `createTestEnv()`, `assertReplays()` |
| `schedules.json` | Every `@Schedule` | `norn schedules sync` |
| `search-attributes.json` | Every declared search attribute, by name and type | You, when registering them on a namespace |

Commit `.norn/`. Reviewers see what changed in your workers' registered surface, and API code builds without running the generator.

## Syntax only

`norn gen` parses your source files with [oxc-parser](https://oxc.rs) and walks the syntax tree. It never imports your source files and never runs the TypeScript compiler, so it takes milliseconds. (It does load `norn.config.ts`.)

The cost is that it can only use what is written in the source:

- **Decorator options must be literals.** `@Workflow({ taskQueue: 'orders' })` works. `@Workflow({ taskQueue: QUEUE })`, spreads, function calls and template literals with expressions are reported as `non-literal`, because finding their values would mean running your code.
- **Decorated classes must be named exports**, since generated files import them by name.
- **Constructor parameters of activities and services need type annotations**, which is how `norn gen` wires [dependency injection](/norn/guides/dependency-injection/).

It also checks workflow code for sandbox mistakes ([Determinism & the sandbox](/norn/concepts/determinism/#what-norn-checks) lists them), duplicate names and other errors. Problems are printed like compiler diagnostics, with a file, line, column and hint. If there are any, nothing is written.

## `norn.lock.json`

Running executions depend on names: their workflow type, task queue, signal, query and update names, and the activities they schedule. `norn gen` records all of them in `norn.lock.json` next to `norn.config.ts`. Adding a name is always fine. Removing or renaming one, or moving a workflow to another task queue, makes `norn gen` fail until you run `norn gen --accept-rename`. Commit the lock file. See [Versioning & safe deploys](/norn/guides/versioning/#rename-protection-nornlockjson).

## In development and CI

```sh
# regenerate on every change (the starter's pnpm dev runs this for you)
norn gen --watch
# in CI: fail if any generated file is stale, without writing anything
norn gen --check
```

Run `--check` next to `tsc` so a forgotten `norn gen` never ships. Every flag is in the [CLI reference](/norn/reference/cli/#norn-gen).
