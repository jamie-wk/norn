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
| Import an activity class as a value | `import type` it, and call it through `useActivities<T>('namespace')` |
| Import a Node built-in or a worker-side package (`@norn-ts/norn/worker`, `@norn-ts/norn/client`, `@temporalio/client`, ...) | Use it from activities, the worker or API code |
| Read `process.env` | Pass configuration in the workflow input, or read it in an activity |
| `setTimeout`, `setInterval`, `setImmediate` | `sleep()` or `condition()` from `@temporalio/workflow` |
| `crypto.randomUUID()` | `uuid4()` from `@temporalio/workflow` |
| `performance.now()`, `Temporal.Now` | `Date.now()`, or timestamps from `workflowInfo()` |
| Reorder or change activities, timers or child workflows that running executions will replay | `patched()` or worker versioning (see below) |

Workflow files may import `@norn-ts/norn/workflow`, `@norn-ts/norn`, `@temporalio/workflow`, `@temporalio/common`, other workflow classes, and your own modules that do no I/O. Use `import type` for anything else, such as activity classes.

If a workflow file imports something it shouldn't, the worker's bundle build fails at startup (for Node built-ins) or the workflow fails when it replays. Keep workflow files and the modules they import separate from activity code, for example under `src/workflows/`.

## Determinism across deploys

The sandbox removes most runtime sources of non-determinism. What it can't remove is the one in the diagram at the top: a deploy that changes the commands an execution already recorded. Temporal gives you several tools for this:

- **Keep names stable.** Running executions depend on the workflow type, task queue, handler and activity names (`<namespace>.<method>`). Renaming one breaks them.
- **`patched()`** from `@temporalio/workflow` puts new behavior behind a marker that old histories replay around.
- **Worker versioning** can pin an execution to the build it started on: set `versioning` in `@Workflow`, and `workerDeploymentOptions` through `createWorker({ workerOptions })`.
- **Replay tests** run recorded histories through your new code in CI; see [Testing](/norn/guides/testing/#replay-tests).

Temporal's [versioning docs](https://docs.temporal.io/develop/typescript/versioning) cover each in depth.
