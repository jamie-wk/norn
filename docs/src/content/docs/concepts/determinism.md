---
title: Determinism & the sandbox
description: Why workflow code must make the same decisions on every replay, what the sandbox does about it, and what Norn checks for you.
---

A workflow is [replayed](/norn/concepts/durable-execution/#what-happens-when-the-worker-crashes-mid-wait) whenever a worker needs to rebuild its state: after a crash, a deploy, or when the worker evicts it from its cache. Replay runs `run()` again from the top and checks each command it produces against the recorded history. So workflow code must be **deterministic**: given the same history, it must make the same decisions, in the same order, every time.

Here is the order workflow from the [previous page](/norn/concepts/durable-execution/), recorded by one version of the code and replayed by the next, which added a `sleep()` before the charge:

```text
 v1 recorded                          v2 replays
 ───────────                          ──────────
 charge(...)                          sleep('1 hour')        <- added in v2
   │                                    │
   ▼                                    ▼
 event: ActivityTaskScheduled    ≠    command: StartTimer
        payments.charge               → non-determinism error
```

When the commands don't match the history, Temporal stops the workflow task with a non-determinism error. The workflow stays open and retries the task until you deploy code that replays cleanly.

## What the sandbox does

The Temporal SDK doesn't run workflow code in your worker's normal Node environment. It bundles each worker's workflow code separately and runs it in an isolated V8 context, the **workflow sandbox**. Inside it:

- `Date.now()` and `new Date()` return the time of the current workflow task, which is recorded in history. A replay sees the same time.
- `Math.random()` is seeded by Temporal, so a replay gets the same numbers.
- `setTimeout` is emulated with a durable timer.
- `WeakRef` and `FinalizationRegistry` throw a `DeterminismViolationError`, because garbage collection timing differs between runs.
- There are no Node APIs: no `fs`, no `net`, no `process`. Importing a Node built-in makes the workflow bundle fail to build.

It doesn't make `performance.now()` or `Temporal.Now` (the TC39 Temporal API) deterministic, and Web Crypto isn't available. Nor can it help when the code itself changed.

## What workflow code must not do

| Don't | Do instead |
| --- | --- |
| Network, file or database I/O | Call an [activity](/norn/guides/activities/) through `useActivities()` |
| Import an `@Activities` or `@Service` class | Import the generated reference from `.norn/activities.ts`, or use `import type` |
| Import a Node built-in or a worker-side package (`@norn-ts/activity`, `@temporalio/client`, ...) | Use it from activities, the worker or API code |
| Read `process.env` | Pass configuration in the workflow input, or read it in an activity |
| `setTimeout`, `setInterval`, `setImmediate` | `sleep()` or `condition()` from `@temporalio/workflow` |
| `crypto.randomUUID()` | `uuid4()` from `@temporalio/workflow` |
| `performance.now()`, `Temporal.Now` | `Date.now()`, or timestamps from `workflowInfo()` |
| Reorder or change activities, timers or child workflows that running executions will replay | `patched()` or worker versioning (see below) |

Workflow files may import `@norn-ts/workflow`, `@norn-ts/core`, `@temporalio/workflow`, `@temporalio/common`, the generated `.norn/activities.ts`, and your own modules that do no I/O.

## What Norn checks

Norn checks workflow code in two places. Neither runs your code.

### `norn gen`

`norn gen` knows exactly which files are workflow code: every file that declares a `@Workflow` class, plus every relative module those files import, followed transitively. In all of them it reports:

- **`import-boundary`**: an import of a Node built-in, of a package that only works outside the sandbox (`@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, and `@norn-ts/activity`, `worker`, `client`, `testing`, `hono` and `cli`), or of a module that declares an `@Activities` or `@Service` class. The message shows the import chain that led there.
- **`determinism`**: a use of `setTimeout`, `setInterval`, `setImmediate`, `process`, `Temporal.Now`, `crypto`, `performance`, `WeakRef` or `FinalizationRegistry`, including through `globalThis.` and `Temporal` from `@js-temporal/polyfill` or `temporal-polyfill`. A local variable with the same name, and uses in type positions, are not reported.

Top-level `import type` is always allowed. An import whose specifiers are all inline `type` (`import { type Charge } from ...`) is reported, because under `verbatimModuleSyntax` it still loads the module. `Date.now()`, `new Date()` and `Math.random()` are not reported, since the sandbox makes them deterministic.

### The ESLint plugin

`@norn-ts/eslint-plugin` gives similar feedback in your editor, one file at a time. Its recommended config applies two rules to files matching `**/*.workflow.ts`, `**/workflows/**/*.ts` and `**/.norn/workflows.ts`:

- **`norn/workflow-determinism`** reports the same globals as `norn gen`. With `{ strict: true }` it also reports `Date.now()`, argument-less `new Date()` and `Math.random()`.
- **`norn/no-activity-imports`** reports Node built-ins, the same worker-side packages, and activity or service modules. Since it sees one file at a time, it recognizes activity code by **path** (`**/activities/**`, `**/services/**`, `*.activities.ts`, `*.service.ts`, ...) rather than by decorator. With `{ onlyAllowed: true }` it reports every package not on an allow list.

See [ESLint rules](/norn/guides/eslint/) for setup and options.

:::caution
Neither check looks inside third-party packages, or can tell that a change to your workflow logic would replay differently. Replay tests catch the second; see below.
:::

## Determinism across deploys

The sandbox removes most runtime sources of non-determinism. What it can't remove is the one in the diagram at the top: a deploy that changes the commands an execution already recorded. Norn and Temporal give you several tools for this:

- **`norn.lock.json`** makes `norn gen` fail when a workflow type, signal, query, update or activity name disappears, or a workflow changes task queue.
- **`patched()`** from `@temporalio/workflow` puts new behavior behind a marker that old histories replay around.
- **Worker versioning** can pin an execution to the build it started on.
- **Replay tests** with `assertReplays()` run recorded histories through your new code in CI.

[Versioning & safe deploys](/norn/guides/versioning/) explains each one and when to use it.
