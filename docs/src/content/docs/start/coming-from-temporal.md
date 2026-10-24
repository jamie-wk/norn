---
title: Coming from the Temporal SDK
description: How each part of the Temporal TypeScript SDK maps to Norn, and what stays exactly the same.
---

If you already write Temporal workflows in TypeScript, you know most of Norn. It runs on the official SDK (1.24), so the execution model, the workflow sandbox, determinism, history, replay, task queues, retries and versioning are all unchanged. Norn changes how you **declare** things: classes and decorators instead of `defineSignal()` and string names, and a client typed from the workflow class.

## What stays the same

- Inside workflows you still import `sleep`, `condition`, `patched`, `workflowInfo`, `CancellationScope` and the rest from `@temporalio/workflow`.
- Inside activities you still import `heartbeat`, `Context` and `ApplicationFailure` from `@temporalio/activity` and `@temporalio/common`.
- The workflow sandbox and its rules.
- Data converters, interceptors, plugins, schedules, worker versioning and the Web UI.
- Every Norn wrapper exposes the SDK object underneath: `norn.temporal` and `handle.temporal` are the SDK client and handle, and `createWorker()` passes `workerOptions` and `plugins` through to `Worker.create()`. If Norn doesn't cover something, use the SDK.

## The mapping

| Temporal SDK | Norn | Guide |
| --- | --- | --- |
| `export async function orderWorkflow(input)` | `@Workflow({ taskQueue, id })` on a class; `run(input)` is the body; the type name is the class name | [Workflows](/norn/guides/workflows/) |
| `defineSignal()` + `setHandler()` | `@Signal()` on a method | [Workflows](/norn/guides/workflows/#signals) |
| `defineQuery()` + `setHandler()` | `@Query()` on a method | [Workflows](/norn/guides/workflows/#queries) |
| `defineUpdate()` + `setHandler(..., { validator })` | `@Update()` and `@Validate('method')` | [Workflows](/norn/guides/workflows/#updates) |
| `proxyActivities<typeof acts>({ startToCloseTimeout, retry })` | `useActivities<PaymentActivities>('payments', { timeout, retries })` | [Activities](/norn/guides/activities/) |
| `retry.nonRetryableErrorTypes` | `nonRetryable: ['CardDeclinedError']` | [Activities](/norn/guides/activities/#errors-and-retries) |
| An `activities` object of functions | A plain class, registered as `activities: { payments: new PaymentActivities(gateway) }` | [Activities](/norn/guides/activities/) |
| `Worker.create({ workflowsPath, activities, taskQueue })` | `createWorker({ workflows, activities })`: one worker per task queue your workflows declare, with graceful shutdown | [Worker](/norn/guides/worker/) |
| `client.workflow.start('orderWorkflow', { taskQueue, workflowId, args })` | `norn.workflow(OrderWorkflow).start(input)`: name, task queue and ID come from the class | [Client](/norn/guides/client/) |
| `client.workflow.getHandle(\`order-${id}\`)` | `norn.workflow(OrderWorkflow).get({ orderId })` | [Client](/norn/guides/client/#handles) |
| `executeChild()` / `startChild()` | `useChild(ChildWorkflow)` | [Workflows](/norn/guides/workflows/#child-workflows) |
| `getExternalWorkflowHandle()` | `useExternal(OtherWorkflow, { id fields })` | [Workflows](/norn/guides/workflows/#child-workflows) |
| `continueAsNew<typeof wf>(...)` | `continueAsNew(...)`, typed against `run()` | [Workflows](/norn/guides/workflows/#long-running-workflows) |
| `upsertSearchAttributes()` with `defineSearchAttributeKey()` | `searchAttributes` in `@Workflow`, then `setSearchAttributes()` | [Workflows](/norn/guides/workflows/#search-attributes) |
| Catching `ActivityFailure` and checking `cause.type` | `asFailure(error, 'CardDeclinedError')` | [Workflows](/norn/guides/workflows/#failures) |
| `WorkflowExecutionAlreadyStartedError`, `WorkflowNotFoundError`, … on the client | `NornError` subclasses with a `code` and an HTTP status | [Client](/norn/guides/client/#errors) |
| `TestWorkflowEnvironment` + a hand-written activities object | `useTestEnv({ workflows, activities })` with fake activity objects | [Testing](/norn/guides/testing/) |
| `bundleWorkflowCode()` | `bundleWorkflows(workflows, { outFile })` | [Worker](/norn/guides/worker/#production) |

## What Norn adds

- **A client typed from the workflow.** Pass the class to `norn.workflow()`. Its input, result, and the arguments and results of its signals, queries and updates are all checked at compile time.
- **ID templates.** `id: 'order-{orderId}'` is checked against `run()`'s input and used everywhere the workflow is started or looked up.
- **Errors with codes.** Client failures become `NornError`s with a stable `code` and an HTTP status, so an API can map them without string matching.

## Things to know

- Decorators don't change types, so TypeScript can't tell a signal method from a query method. `handle.signal('getStatus')` compiles, and fails when it runs. Argument and result types are always checked.
- Activities are registered as `<namespace>.<method>`, such as `payments.charge`. Keep the namespace and method names stable while workflows that call them are running, and keep workflow and handler names stable too: running executions depend on them.
- To move an existing SDK workflow to Norn, keep its workflow type name (the class name, or `@Workflow({ name })`) and every handler name the same, and in-flight executions keep working. Test with the SDK's `Worker.runReplayHistories()` before switching over.

Ready to try it? Start with the [quickstart](/norn/start/quickstart/).
