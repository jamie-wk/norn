---
title: "API reference"
description: Everything @norn-ts/norn exports, by entry point.
---

Norn is one package, `@norn-ts/norn`, with an entry point for each place code runs. Its peer dependencies are the Temporal SDK packages (`@temporalio/client`, `common`, `worker`, `workflow`, and `testing` for tests) and, for `/vite`, `esbuild`.

## `@norn-ts/norn/workflow`

For workflow code. Safe in the workflow sandbox.

| Export | Description |
| --- | --- |
| `@Workflow(options)` | Marks a workflow class. Options: `taskQueue` (required), `name`, `id`, `versioning`, `searchAttributes`, `failOn`, `drainHandlers`. [Guide](/norn/guides/workflows/#workflow-options) |
| `@Signal(nameOrOptions?)` | A signal handler. Options: `name`, `description`, `unfinishedPolicy`, `dedupeBy`. |
| `@Query(nameOrOptions?)` | A synchronous query handler. Options: `name`, `description`. |
| `@Update(nameOrOptions?)` | An update handler. Options: `name`, `description`, `unfinishedPolicy`. |
| `@Validate(updateMethod)` | A synchronous validator for an update. |
| `useActivities<T>(namespace, options?)` | Typed functions that schedule `namespace.<method>` for each method of class `T`. Options are [`ActivityOptions`](#activityoptions) plus `methods` for per-method overrides. [Guide](/norn/guides/activities/) |
| `useChild(WorkflowClass, defaults?)` | `start()` and `execute()` for a child workflow. |
| `useExternal(WorkflowClass, target)` | `signal()` and `cancel()` for a workflow this one didn't start. `target` is ID template fields or `{ workflowId }`. |
| `continueAsNew(input \| () => input, options?)` | Continues as a new run, after in-flight handlers finish. Never returns. |
| `continueAsNewSuggested()` | `true` when Temporal suggests continuing as new. |
| `setSearchAttributes(values)` | Sets declared search attributes; `null` clears one. |
| `asFailure(error, typeOrClass)` / `isFailure(...)` | Finds an `ApplicationFailure` of that type in an error's cause chain. |
| `implement(WorkflowClass)` | The Temporal workflow function for a class. The worker calls it for you. |
| `describeWorkflow(cls)`, `contractOf(cls)`, `isWorkflowClass(value)` | What Norn reads from a class's decorators. |

## `@norn-ts/norn/worker`

| Export | Description |
| --- | --- |
| `createWorker(options)` | Creates a worker. Returns `{ run(), shutdown(), state, taskQueues, config }`, and is `AsyncDisposable`. [Guide](/norn/guides/worker/) |
| `bundleWorkflows(workflows, { outFile?, payloadConverterPath?, plugins?, webpackConfigHook?, ... })` | Bundles a workflows module ahead of time. |
| `resolveWorkerConfig(options, env?)` | The connection settings `createWorker()` would use. |
| `activityFunctions(activities)` | The activity functions `createWorker()` registers: `{ 'payments.charge': fn, ... }`. |
| `loadWorkflows(workflows)` | Reads a workflows module: its resolved path, task queues and search attributes. Writes nothing. |
| `nornWebpackConfigHook()`, `composeWebpackHooks()` | Norn's webpack settings, for custom bundling. |

## `@norn-ts/norn/client`

| Export | Description |
| --- | --- |
| `createClient(options?)` | A client. `workflow(WorkflowClass)` returns a typed `WorkflowClient`. [Guide](/norn/guides/client/) |
| `WorkflowClient` | `start()`, `execute()`, `get()`, `signalWithStart()`, `updateWithStart()`, `list()`, `count()`. |
| `WorkflowHandle` | `signal()`, `query()`, `update()`, `result()`, `cancel()`, `terminate()`, `describe()`, `workflowId`, `runId`, `temporal`. |
| `toNornError(error, context)` | Converts a Temporal client error into a Norn error. |
| Error classes | Re-exported from `@norn-ts/norn`. |

## `@norn-ts/norn/testing`, `/vitest`, `/vite`

| Export | Description |
| --- | --- |
| `createTestEnv(options)` (`/testing`) | A test server, client and worker. [Guide](/norn/guides/testing/) |
| `useTestEnv(options)` (`/vitest`) | `createTestEnv()` in `beforeAll`, torn down in `afterAll`. |
| `standardDecorators(options?)` (`/vite`) | A Vite plugin that lowers TC39 decorators with esbuild. |

## `@norn-ts/norn`

Shared types and errors, safe everywhere including workflow code.

| Export | Description |
| --- | --- |
| `NornError` | Base class: `code`, `status`, `details`, `cause`, `toJSON()`. |
| `NornConfigError` | `CONFIG`, 500. Invalid options or input. |
| `WorkflowAlreadyStartedError`, `WorkflowNotFoundError`, `WorkflowClosedError`, `UpdateRejectedError`, `QueryFailedError`, `WorkflowFailedError`, `TemporalUnavailableError` | Client errors. [Table](/norn/guides/client/#errors) |
| `isNornError(value)` | Type guard. |
| `toMs(duration)` | A `Duration` in milliseconds. |
| `Duration`, `ActivityOptions`, `RetryOptions`, `SearchAttributeType` | Types. |

### `ActivityOptions`

| Option | Description |
| --- | --- |
| `timeout` | Start-to-close timeout. Default 1 minute. |
| `scheduleToClose`, `scheduleToStart`, `heartbeat` | The other activity timeouts. |
| `retries` | Retries after the first attempt. |
| `retry` | `{ initialInterval, backoffCoefficient, maximumInterval, maximumAttempts }`. |
| `nonRetryable` | Error names that are never retried. |
| `local` | Run as a local activity. |
| `taskQueue`, `summary` | Task queue and UI summary. |

### `Duration`

A number of milliseconds, or a string: `'500ms'`, `'30s'`, `'5 minutes'`, `'1h30m'`, `'2 days'`, or ISO 8601 such as `'PT15M'`. Months and years are rejected, because they have no fixed length.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, `TEMPORAL_TLS` | worker, client | Connection settings. |
| `NORN_WORKFLOW_BUNDLE` | worker | A prebuilt workflow bundle, for workers with `workflows`. |
| `NORN_TEMPORAL_CLI_PATH`, `NORN_TEMPORAL_TEST_SERVER_PATH` | testing | Existing Temporal binaries instead of downloads. |
| `NORN_TEST_LOG_LEVEL` | testing | SDK log level in tests. Default `WARN`. |
| `NORN_DEV_CONDITIONS` | worker | Extra export conditions for the workflow bundler, for monorepos that resolve packages to source. |
