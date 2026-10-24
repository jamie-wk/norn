---
title: Coming from the Temporal SDK
description: How each part of the Temporal TypeScript SDK maps to Norn, what Norn adds, and what stays exactly the same.
---

If you already write Temporal workflows in TypeScript, you know most of Norn. It runs on the official SDK (1.24), so the execution model, the workflow sandbox, determinism, history, replay, task queues, retries and versioning are all unchanged. Norn changes how you **declare** things: classes and decorators instead of `defineSignal()` and string names, and generated code instead of hand-kept glue.

## What stays the same

- Inside workflows you still import `sleep`, `condition`, `patched`, `deprecatePatch`, `workflowInfo`, `CancellationScope` and the rest from `@temporalio/workflow`.
- The workflow sandbox and its rules. Norn adds earlier checks, but it doesn't relax anything.
- Payload converters, interceptors, plugins, worker versioning and the Web UI.
- Every Norn wrapper exposes the SDK object underneath: `client.temporal` and `handle.temporal` are the SDK client and handle, and `createWorker()` passes `workerOptions` and `plugins` through to the SDK worker. If Norn doesn't cover something, use the SDK.

## The mapping

| Temporal SDK | Norn | Guide |
| --- | --- | --- |
| `export async function orderWorkflow(input)`, registered by export name | `@Workflow({ taskQueue, id })` on a class; `run(input)` is the body; the type name is the class name | [Workflows](/norn/guides/workflows/) |
| `defineSignal()` + `setHandler()` | `@Signal()` on a method | [Messages](/norn/guides/messages/) |
| `defineQuery()` + `setHandler()` | `@Query()` on a method | [Messages](/norn/guides/messages/#queries) |
| `defineUpdate()` + `setHandler(..., { validator })` | `@Update()` and `@Validate('method')` | [Messages](/norn/guides/messages/#updates) |
| `proxyActivities<typeof acts>({ startToCloseTimeout, retry })` | `@Activity({ timeout, retries })` on the activity method; `useActivities(Ref)` in the workflow | [Activities](/norn/guides/activities/) |
| `retry.nonRetryableErrorTypes: ['CardDeclinedError']` | `@NonRetryable([CardDeclinedError])` | [Activities](/norn/guides/activities/#nonretryable) |
| An `activities` object built by hand, with module-level clients | `@Activities` classes with constructor-injected `@Service`s, wired by `norn gen` | [Dependency injection](/norn/guides/dependency-injection/) |
| `Worker.create({ workflowsPath, activities, taskQueue })` | `createWorker({ registry })`: one worker per task queue in the registry, with health checks and graceful shutdown | [Worker](/norn/guides/worker/) |
| `client.workflow.start('orderWorkflow', { taskQueue, workflowId, args })` | `norn.workflow(OrderWorkflow).start(input)`: name, task queue and ID come from the contract | [Client](/norn/guides/client/) |
| `client.workflow.getHandle(\`order-${id}\`)` | `norn.workflow(OrderWorkflow).get({ orderId })` | [Client](/norn/guides/client/#handles) |
| `executeChild()` / `startChild()` | `useChild(ChildWorkflow)` | [Child workflows](/norn/guides/child-workflows/) |
| `getExternalWorkflowHandle()` | `useExternal(OtherWorkflow)` | [Child workflows](/norn/guides/child-workflows/#external-workflows-useexternal) |
| `continueAsNew<typeof wf>(...)` | `continueAsNew(...)` from `@norn-ts/workflow`, typed against `run()` | [Long-running workflows](/norn/guides/long-running/) |
| `upsertSearchAttributes()` with `defineSearchAttributeKey()` | `searchAttributes` in `@Workflow`, then `setSearchAttributes()` | [Workflows](/norn/guides/workflows/#search-attributes) |
| `client.schedule.create(...)` in a deploy script | `@Schedule(cron)` on the workflow, then `norn schedules sync` | [Schedules](/norn/guides/schedules/) |
| Catching `ActivityFailure` and checking `cause.type` | `asFailure(error, CardDeclinedError)` | [Errors](/norn/guides/errors/#handling-activity-failures-in-workflows) |
| `WorkflowExecutionAlreadyStartedError`, `WorkflowNotFoundError`, ... on the client | `NornError` subclasses with a `code` and an HTTP status | [Errors](/norn/guides/errors/#client-errors) |
| `TestWorkflowEnvironment` + a hand-written activities object | `createTestEnv()` / `useTestEnv()` + typed `mockActivities()` | [Testing](/norn/guides/testing/) |
| `Worker.runReplayHistories()` | `assertReplays()` and `norn histories pull` | [Versioning](/norn/guides/versioning/#replay-tests) |
| `bundleWorkflowCode()` | `norn bundle` / `bundleWorkflows()` | [Worker](/norn/guides/worker/#production-builds-compile-then-bundle) |

## What Norn adds

- **Contracts.** `norn gen` writes a contract for each workflow into `.norn/contracts.ts`. It imports the workflow class with `import type` only, so API code is fully typed without bundling any workflow code. [Contracts & the client/worker split](/norn/concepts/contracts/) explains how.
- **ID templates.** `id: 'order-{orderId}'` is checked against `run()`'s input at compile time and used everywhere the workflow is started or looked up.
- **Earlier sandbox checks.** Workflows reference activities through generated, type-only references. `norn gen` and the [ESLint rules](/norn/guides/eslint/) flag imports that would break the bundle or replay before you run anything.
- **Rename protection.** `norn.lock.json` records every workflow type, handler, activity and task queue name. Renaming one is an error until you confirm it, because running executions still use the old names.
- **Production plumbing.** Health endpoints, SIGTERM draining, correlation IDs from HTTP request to activity log line, Prometheus metrics, [payload encryption](/norn/guides/encryption/), and a [Hono integration](/norn/guides/hono/) that maps errors to HTTP statuses.

## Adopting Norn in an existing codebase

You don't have to convert everything at once:

- **Call existing workflows with typed handles.** Write a [manual contract](/norn/guides/client/#manual-contracts) with `defineWorkflow()` for a workflow that isn't written with Norn, and use it with `createClient()`, `useChild()` and `useExternal()`. This also works for workflows written in other languages.
- **Keep the SDK client.** `createClient({ connection })` reuses an existing `Connection`, and `norn.temporal` is the SDK `Client`.
- **Move one workflow at a time.** Keep the workflow type name (the class name, or `@Workflow({ name })`) and every signal, query and update name the same, and in-flight executions keep working. Run [replay tests](/norn/guides/versioning/#replay-tests) against histories recorded from the old version before switching over.

Ready to try it? Start with the [quickstart](/norn/start/quickstart/), or follow [Manual setup](/norn/guides/manual-setup/) to add Norn to an existing project.
