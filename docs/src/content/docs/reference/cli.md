---
title: "@norn-ts/cli"
description: "The norn command: code generation, schedule sync, history download and workflow bundling."
sidebar:
  order: 8
---

`@norn-ts/cli` provides the `norn` command. It reads your `@Workflow`, `@Activities` and `@Service` classes and generates the glue Temporal needs: the workflow bundle entry, workflow-safe activity references, typed contracts for API code, the dependency-injection container and the worker registry. It also checks that workflow code stays inside the sandbox, keeps a lock file of every name that in-flight executions depend on, syncs `@Schedule`s to Temporal, pulls histories for replay tests and bundles workflows for production.

`norn gen` never runs your code. It parses the TypeScript source with [oxc](https://oxc.rs) and reads decorators syntactically, so it is fast, works before anything compiles, and cannot trigger side effects. The price is that decorator options must be literals (see [Decorator options are literals](#decorator-options-are-literals)). [Codegen & .norn/](/norn/concepts/codegen/) explains the design.

## Install

```sh
pnpm add -D @norn-ts/cli
```

Run it through your package manager (`pnpm norn gen`, `npx norn gen`). Requires Node 22.18+: `norn.config.ts` is loaded with Node's built-in TypeScript type stripping.

| Command | What it does |
| --- | --- |
| [`norn gen`](#norn-gen) | Generates `.norn/` and `norn.lock.json` from your decorated classes and checks them. `--check` in CI, `--watch` while developing. |
| [`norn bundle`](#norn-bundle) | Builds the production workflow bundle. |
| [`norn schedules sync`](#norn-schedules-sync) | Creates, updates and removes Temporal schedules to match `@Schedule` declarations. |
| [`norn histories pull`](#norn-histories-pull) | Downloads workflow histories as JSON for replay tests. |

`norn --help` (or `norn help`), `norn <command> --help` (or `norn help <command>`) and `norn --version` (`-v`) print help and the version.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The command ran and found problems: generation errors, stale files with `--check`, schedule conflicts, or a runtime error such as a failed connection. |
| `2` | Usage error: unknown command or flag, unexpected argument, missing subcommand, or `--check` with `--watch`. |

## Configuration

### `norn.config.ts`

```ts
import { defineConfig } from '@norn-ts/cli';

export default defineConfig({
  include: ['src/**/*.ts'],
  exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts', '**/node_modules/**'],
  outDir: '.norn',
  providers: 'src/providers.ts',
  importExtension: '.js',
  contracts: { outFile: '../contracts/src/index.ts' },
});
```

| Option | Default | Description |
| --- | --- | --- |
| `include` | `['src/**/*.ts']` | Globs of source files to scan. Patterns may climb out of the root (`'../shared/**/*.ts'`). |
| `exclude` | `['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts', '**/node_modules/**']` | Globs to skip. `outDir` and `contracts.outFile` are always skipped. |
| `outDir` | `'.norn'` | Where generated files are written. |
| `providers` | none | A module with `export const providers = [provide(...), ...]`, passed to the container. `norn gen` checks that the file exists and has that export. |
| `importExtension` | `'.js'` | Extension of relative imports in generated files: `'.js'` or `'.ts'`. Use `'.ts'` with `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`, or when running sources directly. |
| `contracts.outFile` | none | Also write the contracts to this file, with imports relative to it, such as a package shared with API code. |

`defineConfig(config)` is an identity function that type-checks the config. The file needs a default export that is an object. Unknown options and wrong types are reported as `config` errors.

### Finding the config

`norn` finds the nearest `norn.config.ts` (or `norn.config.mts`, `.js`, `.mjs`) at or above the working directory, or uses the file passed with `--config <path>` (relative to the working directory; it must exist). The config file's directory is the **project root**, and paths in the config are relative to it. Without a config file, the working directory is the root and every option takes its default. `norn.lock.json` is always written to the project root.

## `norn gen`

```sh
# write everything that changed, and norn.lock.json
norn gen
# CI: exit 1 if anything is missing or stale; write nothing
norn gen --check
# regenerate on every change to a TypeScript file under the root
norn gen --watch
# accept workflow types, handlers and activities removed from norn.lock.json
norn gen --accept-rename
# use this config file instead of the nearest one
norn gen --config path/to/norn.config.ts
```

| Flag | Description |
| --- | --- |
| `--check` | Compare with the files on disk; exit 1 if any are missing or stale. Writes nothing. |
| `--watch` | Generate, then regenerate whenever a `.ts`, `.tsx`, `.mts` or `.cts` file under the project root changes (outside `outDir`, `node_modules` and `contracts.outFile`). Stops on SIGINT or SIGTERM. |
| `--accept-rename` | Accept names removed from `norn.lock.json`, and update it. |
| `--config <path>` | Use this config file. |

`--check` and `--watch` can't be combined. `norn gen` only rewrites files whose content changed, and its output is deterministic: entries are sorted and formatting is stable, so generated files diff cleanly. Commit `norn.lock.json`; whether you commit `.norn/` is up to you (`norn gen --check` in CI works either way).

On success it prints `wrote <file>` for each file it changed, or `Generated files are up to date.` With `--check` it prints `All generated files are up to date.`, or the list of stale files and exits 1.

On any error nothing is written. Every problem is printed as a compiler-style diagnostic with its location and a hint, then `Found N errors.`, and the command exits 1:

```text
src/workflows/order.workflow.ts:10:5 - error norn(determinism): setTimeout in workflow code: the sandbox only emulates it with a durable timer, and a callback timer easily outlives the code that needed it
  hint: Use await sleep(ms) from '@temporalio/workflow', or await condition(() => ..., timeout).

Found 1 error.
```

See [Project layout & codegen](/norn/guides/project-layout/) for how the generated files fit into a project.

### What gets generated

Given this workflow and activity class:

```ts
// src/workflows/order.ts
import { Query, Signal, Update, Validate, Workflow, useActivities } from '@norn-ts/workflow';
import { PaymentActivities } from '../../.norn/activities.js';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}', searchAttributes: { CustomerId: 'keyword' } })
export class OrderWorkflow {
  private readonly pay = useActivities(PaymentActivities);

  /** Cancel the order and refund the charge. */
  @Signal() cancel(reason: string) { /* ... */ }
  @Signal({ name: 'transfer-event', dedupeBy: (e: { eventId: string }) => e.eventId }) transferEvent(e: { eventId: string }) { /* ... */ }
  @Query('status') getStatus() { /* ... */ }
  @Validate('addItem') checkItem(sku: string) { /* ... */ }
  @Update({ name: 'add-item' }) addItem(sku: string) { /* ... */ }
  async run(input: { orderId: string; cents: number }) { /* ... */ }
}

// src/activities/payment.ts
@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  constructor(private readonly transfers: TransferService, private readonly config: Config) {}

  @Activity({ timeout: '1m', retries: 3 })
  @NonRetryable([InvalidCardError])
  async charge(orderId: string, cents: number): Promise<Charge> { /* ... */ }
}
```

`norn gen` writes the following files. Every `.ts` file starts with `// Generated by norn gen. Do not edit.`

#### `.norn/workflows.ts`: the workflow bundle entry

Temporal registers workflows by the **export names** of the bundle entry, so each export is named after the workflow type (`@Workflow({ name })`, or the class name). Only workflow files are imported. JSDoc comments on handlers become handler descriptions.

```ts
import { implement } from '@norn-ts/workflow';
import { CartWorkflow as ShoppingCart$ } from '../src/workflows/cart.js';
import { OrderWorkflow as OrderWorkflow$ } from '../src/workflows/order.js';

export const OrderWorkflow = implement(OrderWorkflow$, {
  descriptions: { cancel: 'Cancel the order and refund the charge.' },
});
export const ShoppingCart = implement(ShoppingCart$, { descriptions: { pause: 'Pause processing.' } });
```

#### `.norn/activities.ts`: workflow-safe activity references

Only `import type` of activity classes, so workflow bundles never contain activity code. `@Activity` options are copied as written. `@NonRetryable([X])` on the method (or else on the class) adds `nonRetryable: ['X']` by class name. `@NonRetryable()` without arguments adds nothing here: the worker applies it at runtime.

```ts
import { defineActivities } from '@norn-ts/workflow';
import type { PaymentActivities as PaymentActivities$ } from '../src/activities/payment.js';

export const PaymentActivities = defineActivities<PaymentActivities$>()({
  prefix: 'payments.',
  methods: {
    charge: { timeout: '1m', retries: 3, nonRetryable: ['InvalidCardError'] },
    refund: { name: 'refund-charge', timeout: '30s', retry: { initialInterval: '1s', backoffCoefficient: 2 } },
  },
});
```

#### `.norn/contracts.ts` (and `contracts.outFile`): typed contracts for API code

`import type` only. Handler maps go from method name to registered name, so `client.workflow(OrderWorkflow).signal('transferEvent', ...)` sends `transfer-event`. Inherited handlers (from a base class that `norn gen` can find through relative imports) are included. See [Contracts](/norn/concepts/contracts/).

```ts
import { contract } from '@norn-ts/core';
import type { OrderWorkflow as OrderWorkflow$ } from '../src/workflows/order.js';

export const OrderWorkflow = contract<typeof OrderWorkflow$>()({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  id: 'order-{orderId}',
  signals: { cancel: 'cancel', complete: 'complete', transferEvent: 'transfer-event' },
  queries: { getStatus: 'status' },
  updates: { addItem: 'add-item' },
  searchAttributes: { CustomerId: 'keyword', OrderStatus: 'keyword' },
});
```

#### `.norn/container.ts`: dependency injection

Every `@Service` and `@Activities` class with its constructor dependencies, plus your `providers`:

```ts
import { createContainer } from '@norn-ts/activity';
import type { RegistryContainerOptions } from '@norn-ts/worker';
import { PaymentActivities } from '../src/activities/payment.js';
import { providers } from '../src/providers.js';
import { Config, Db } from '../src/services/tokens.js';
import { BankTransferService, TransferService } from '../src/services/transfer.js';

export function createNornContainer(options: RegistryContainerOptions = {}) {
  return createContainer({
    providers,
    services: [{ cls: BankTransferService, deps: [Db, Config] }],
    activities: [{ cls: PaymentActivities, deps: [TransferService, Config] }],
    ...options,
  });
}
```

Dependencies come from `inject: [...]` when the decorator has it. Otherwise `norn gen` reads the **type annotations** of the constructor parameters (parameter properties such as `private readonly db: Db` included, and the base class's constructor when the class has none). Each type must name something with a runtime value:

- a class, or
- an interface with a **same-named token**, the Norn convention:

  ```ts
  export interface TransferService { send(t: Transfer): Promise<string> }
  export const TransferService = token<TransferService>('TransferService');
  ```

The name is resolved through the file's imports (following re-exports and `index.ts` files, mapping `.js` specifiers to `.ts` sources) to the module that declares the value, and imported from there. Names from packages (`import { Pool } from 'pg'`) are imported from the package as-is. Namespace-qualified types (`db: tokens.Db`) work too. Same-named keys from different modules get aliases (`Config$1`). See [Dependency injection](/norn/guides/dependency-injection/).

#### `.norn/registry.ts`: everything a worker needs

```ts
import { fileURLToPath } from 'node:url';
import type { NornRegistry } from '@norn-ts/worker';
import { createNornContainer } from './container.js';

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

export const registry = {
  workflowsPath: fileURLToPath(new URL(`./workflows${ext}`, import.meta.url)),
  taskQueues: ['carts', 'orders', 'reports'],
  activities: ['payments.charge', 'payments.refund-charge'],
  searchAttributes: { CartSize: 'int', CustomerId: 'keyword', OrderStatus: 'keyword' },
  createContainer: createNornContainer,
} satisfies NornRegistry;
```

Pass it to `createWorker({ registry })` from [`@norn-ts/worker`](/norn/reference/worker/).

#### `.norn/search-attributes.json`

Every custom search attribute, merged across workflows, for registering them with your namespace:

```json
{
  "CartSize": "int",
  "CustomerId": "keyword",
  "OrderStatus": "keyword"
}
```

#### `.norn/schedules.json`

One entry per `@Schedule` (a class decorator on a `@Workflow` class; a class can have several), sorted by id. The id defaults to the workflow type name in kebab case (`ReportWorkflow` becomes `report-workflow`). [`norn schedules sync`](#norn-schedules-sync) reads this file.

```ts
@Schedule('0 2 * * *', { id: 'nightly-report', input: { kind: 'daily' }, timeZone: 'America/New_York', overlap: 'buffer-one', note: 'Nightly totals' })
@Schedule(['0 9 * * 1', '0 9 * * 4'], { input: { kind: 'weekly' }, paused: true, pauseOnFailure: true })
@Workflow({ taskQueue: 'reports' })
export class ReportWorkflow { /* ... */ }
```

```json
[
  {
    "id": "nightly-report",
    "workflowType": "ReportWorkflow",
    "taskQueue": "reports",
    "cron": ["0 2 * * *"],
    "input": { "kind": "daily" },
    "overlap": "buffer-one",
    "timeZone": "America/New_York",
    "note": "Nightly totals"
  },
  {
    "id": "report-workflow",
    "workflowType": "ReportWorkflow",
    "taskQueue": "reports",
    "cron": ["0 9 * * 1", "0 9 * * 4"],
    "input": { "kind": "weekly" },
    "pauseOnFailure": true,
    "paused": true
  }
]
```

#### `norn.lock.json`

Written to the project root; commit it. It lists every workflow type, its task queue and handler names, and every activity name:

```json
{
  "version": 1,
  "workflows": {
    "OrderWorkflow": {
      "taskQueue": "orders",
      "signals": ["cancel", "complete", "transfer-event"],
      "queries": ["status"],
      "updates": ["add-item"]
    }
  },
  "activities": ["payments.charge", "payments.refund-charge"]
}
```

New names are added silently. When a locked workflow type, signal, query, update or activity name disappears, or a workflow's task queue changes, `norn gen` fails, because executions already running would break: their next workflow task finds no registered type, signals and updates from existing callers are rejected, scheduled activities have no worker, or tasks wait on the old queue. If the change is intentional (nothing in flight, or you migrated), run `norn gen --accept-rename` to update the lock. See [Versioning](/norn/guides/versioning/).

```text
norn.lock.json - error norn(lock-removed): signal "pause" of OrderWorkflow was removed or renamed; in-flight executions (and callers) still send "pause", which would be rejected or dropped
  hint: If this is intentional (no executions in flight, or they were migrated), run norn gen --accept-rename to update norn.lock.json.
```

### Decorator options are literals

Because `norn gen` does not execute code, decorator options must be written inline as literals: strings, numbers (including negative), booleans, `null`, template literals without `${}`, and arrays or objects of those (`as const` and `satisfies` are fine). The exceptions:

- **class or token references by name** where a class is expected: `inject: [Db, Config]`, `provides: TransferService`, `failOn: [InvalidOrderError]` and `@NonRetryable([InvalidCardError])`;
- **functions** for `dedupeBy` (recorded as present; never evaluated).

```text
src/workflows.ts:5:24 - error norn(non-literal): @Workflow option "taskQueue" must be a literal (a string, number, boolean, null, or an array or object of literals); found identifier QUEUE
  hint: norn gen reads decorators without running your code, so options must be written inline as literals: replace QUEUE with its value.
```

Decorators are recognized when imported by name from `@norn-ts/workflow` or `@norn-ts/activity`, including aliases (`import { Workflow as W }`) and namespace imports (`@nw.Workflow(...)`). Decorators re-exported through your own modules are not recognized.

### Diagnostics

All problems are collected and reported together, each with `file:line:col`, in file and position order.

| Code | Meaning |
| --- | --- |
| `config` | Invalid `norn.config.ts` (missing default export, unknown options, wrong types), or a `providers` module that is missing or has no `providers` export. |
| `parse-error` | A source file does not parse. |
| `non-literal` | A decorator option is not a literal (see [above](#decorator-options-are-literals)). |
| `invalid-option` | A known option has the wrong type or value (`taskQueue: ''`, an invalid workflow `name`, unknown search attribute types, `versioning`, cron expressions, `overlap`, `scope`, activity durations and retries, ...) or an option does not exist. |
| `invalid-decorator` | A decorator factory is used without calling it (`@Signal` instead of `@Signal()`), `@Schedule` on a class without `@Workflow`, a class with two of `@Workflow` / `@Activities` / `@Service` (or one of them twice), an `@Activities` class without `@Activity` methods, a class decorator on a member (or the reverse), or a member decorator in the wrong kind of class. |
| `invalid-member` | A handler or activity decorator on a private (`#x`), static, non-method, computed or symbol-named member. |
| `invalid-validate` | `@Validate('x')` where `x()` is not an `@Update` method, or an update with more than one validator. |
| `missing-run` | A `@Workflow` class (with its base classes) has no `run()` method. |
| `not-exported` | A decorated class, or a locally declared class or token it injects, is not a named export. |
| `missing-annotation` | A constructor parameter has no type annotation and the decorator has no `inject`. |
| `unsupported-type` | A parameter type cannot identify a dependency: primitive (`string`), union, intersection, generic (`Repo<User>`), rest parameter, or a default or namespace import. Use `inject: [token]`. |
| `unresolved-type` | The type is neither imported nor declared, or its relative import does not resolve to a file. |
| `interface-without-token` | The type is only an interface or type alias, with no same-named value to inject. Add `export const X = token<X>('X')`. |
| `duplicate-workflow` | Two workflows with the same type name. |
| `duplicate-handler` | Two signals, queries or updates of one workflow with the same registered name. |
| `duplicate-activity` | Two activities with the same name (prefix + name), in one class or across classes. |
| `duplicate-class` | Two `@Activities` classes with the same class name (both would be exported from `activities.ts`). |
| `duplicate-schedule` | Two schedules with the same id. |
| `search-attribute-conflict` | The same search attribute declared with different types by different workflows. |
| `import-boundary` | Workflow code loads something the workflow sandbox cannot run (see [Import boundaries](#import-boundaries)). |
| `determinism` | Workflow code uses a non-deterministic or unavailable global (see [Determinism](#determinism)). |
| `lock-removed` | A name in `norn.lock.json` disappeared, or a workflow's task queue changed. Use `--accept-rename` if intended. |
| `lock-invalid` | `norn.lock.json` cannot be read. |

#### Import boundaries

Workflow code is every file with a `@Workflow` class plus every relative module it loads, transitively. A helper that imports an activity file is caught at the helper's import, with the import chain in the message. Workflow code must not load:

- a file that declares `@Activities` or `@Service` classes;
- a Node built-in (`fs`, `node:crypto`, ...);
- `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, `@norn-ts/activity`, `@norn-ts/worker`, `@norn-ts/client`, `@norn-ts/testing`, `@norn-ts/hono` or `@norn-ts/cli` (or their subpaths).

`import type` and `export type` are fine. `import { type X } from '...'` is **not**: with only inline `type` specifiers, `verbatimModuleSyntax` keeps it as `import {} from '...'`, which still loads the module. `export ... from` and dynamic `import('...')` count as imports.

```text
src/workflows/order.ts:2:1 - error norn(import-boundary): Workflow code must not import src/activities/payment.ts, which declares @Activities or @Service classes
  hint: Use import type for types; workflows call activities through the generated activities file with useActivities().
```

#### Determinism

In workflow code, references to the globals `setTimeout` (use `sleep()`), `setInterval`, `setImmediate`, `process`, `Temporal.Now`, `crypto`, `performance`, `WeakRef` and `FinalizationRegistry` are errors, including through `globalThis.`, `window.`, `self.` or `global.`, and `const { Now } = Temporal`. Local variables (including hoisted `var`s), parameters and imports with those names are respected. `Temporal` imported from `@js-temporal/polyfill` or `temporal-polyfill`, under any name, is still checked. `Date.now()` and `Math.random()` are fine: the sandbox makes them deterministic. See [Determinism & the sandbox](/norn/concepts/determinism/). For editor feedback, use the rules in [`@norn-ts/eslint-plugin`](/norn/reference/eslint-plugin/).

### Limits of syntax-only analysis

- Inheritance is followed through base classes declared in the same file or imported from relative modules; bases from packages are not read.
- TypeScript `paths` aliases are treated like package names: imported as-is in `container.ts`, and not followed by the import-boundary check.
- Dependencies imported from packages are assumed to be values; `norn gen` does not read `.d.ts` files.

## `norn bundle`

```sh
# writes dist/workflow-bundle.js
norn bundle
# with @norn-ts/codec's payload converter
norn bundle --out build/workflows.js --codec
```

| Flag | Description |
| --- | --- |
| `--out <file>` | Output file, relative to the working directory. Defaults to `dist/workflow-bundle.js`. |
| `--codec` | Include `@norn-ts/codec`'s payload converter (`payloadConverterPath`), which workers using `createDataConverter()` need. |
| `--config <path>` | Use this config file. |

Bundles `<outDir>/workflows.ts` (or `workflows.js`, if you compiled `.norn/`) with [`bundleWorkflows()`](/norn/reference/worker/#bundling-workflows) from `@norn-ts/worker`: standard decorators, `.js`→`.ts` resolution and Norn's workflow interceptors (correlation IDs). It asks you to run `norn gen` first if the workflows barrel is missing, and prints `wrote <file> (<size> KiB) from <barrel>`. Point workers at the file with `workflowBundle: { codePath }` or the `NORN_WORKFLOW_BUNDLE` environment variable. See [Worker & deployment](/norn/guides/worker/#production-builds-compile-then-bundle).

## `norn schedules sync`

```sh
# create missing, update changed, leave unchanged schedules
norn schedules sync
# print the plan only
norn schedules sync --dry-run
# also delete this project's norn-managed schedules that are no longer declared
norn schedules sync --prune
```

| Flag | Description |
| --- | --- |
| `--dry-run` | Print the plan without changing anything. |
| `--prune` | Delete this project's norn-managed schedules that are no longer declared. |
| `--config <path>` | Use this config file. |

Reads `<outDir>/schedules.json` (run `norn gen` first) and makes the namespace's schedules match it. See [Schedules](/norn/guides/schedules/).

```text
created    nightly-report
unchanged  report-workflow
1 created, 0 updated, 1 unchanged, 0 deleted in namespace default.
```

With `--dry-run` the summary starts with `Dry run:` and says `would be created`, `would be updated` and `would be deleted`.

- **Ownership.** Schedules created by `norn` carry the memo `{ nornManaged: '<name>' }`, where `<name>` is the `name` in the `package.json` next to `norn.config.ts` (the command fails without one), so projects can share a namespace. A declared id that already exists **without** this project's memo is reported as a conflict (exit 1) and left alone. `--prune` only ever deletes this project's managed schedules.
- **Change detection.** The workflow action carries a hash of the declared spec in its memo (`nornScheduleHash`). A schedule is updated only when the hash differs, so manual edits in the Temporal UI are kept until the declaration changes. Updates keep the schedule's existing catch-up window.
- **Mapping.** `overlap` maps to Temporal's `ScheduleOverlapPolicy` (`'buffer-one'` becomes `BUFFER_ONE`; the default is `SKIP`). The schedule's input becomes the workflow's single argument. `paused` and `pauseOnFailure` default to `false`.

:::note
`--prune` relies on Temporal's schedule listing, which is eventually consistent: a schedule created a moment ago may not be listed yet.
:::

### Connection

`schedules sync` and `histories pull` connect with these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Server address. |
| `TEMPORAL_NAMESPACE` | `default` | Namespace. |
| `TEMPORAL_API_KEY` | none | API key auth; enables TLS. |
| `TEMPORAL_TLS_CERT`, `TEMPORAL_TLS_KEY` | none | Client certificate and key file paths for mTLS. Set both or neither. Only the CLI reads these two. |
| `TEMPORAL_TLS` | none | `true` to use TLS without either of the above. |

An empty `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` or `TEMPORAL_API_KEY` counts as unset, the same as in `createClient()` and `createWorker()`.

## `norn histories pull`

```sh
norn histories pull order-123 order-456 --out test/histories
```

| Flag | Description |
| --- | --- |
| `<workflowId...>` | One or more workflow IDs. At least one is required. |
| `--out <dir>` | Output directory, relative to the working directory. Defaults to `histories`. |

Writes `<dir>/<workflowId>.json` with the latest run's event history, in the JSON format of `historyToJSON` (what `loadHistories()` and `Worker.runReplayHistory` read). Characters unsafe in file names become `_`; two IDs that map to the same file name are an error. There are no query, run ID or namespace flags. It connects like [`norn schedules sync`](#connection).

Use the files in replay tests to catch non-deterministic changes before you deploy. See [Replay tests](/norn/guides/versioning/#replay-tests).

```ts
import { readFile } from 'node:fs/promises';
import { Worker } from '@temporalio/worker';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils.js';
import { bundleWorkflows } from '@norn-ts/worker';
import { registry } from '../.norn/registry.js';

const history = historyFromJSON(JSON.parse(await readFile('test/histories/order-123.json', 'utf8')));
await Worker.runReplayHistory({ workflowBundle: await bundleWorkflows(registry) }, history);
```

## Programmatic API

```ts
import { generate, watch, formatError } from '@norn-ts/cli';

const result = await generate({ cwd, configPath, check, acceptRename, write });
// { files: Record<path, content>, written: string[], stale: string[], errors: NornGenError[], root }
for (const error of result.errors) console.error(formatError(error));

const controller = new AbortController();
await watch({ cwd, signal: controller.signal, debounceMs: 100, onResult: (r) => console.log(r.written) });
```

| Export | Description |
| --- | --- |
| `generate(options)` | Runs `norn gen`. Options: `cwd` (default `process.cwd()`), `configPath`, `check` (compare with disk, write nothing), `acceptRename`, `write` (default `true`; `false` renders without writing). Paths in the result are relative to the project root; `files` is empty when there are errors. |
| `watch(options)` | Generates, then regenerates on changes until `signal` aborts; resolves when stopped. Takes `generate`'s options except `check` and `write`, plus `signal`, `debounceMs` (default `100`) and `onResult(result)` (called after every generation, including the first). |
| `defineConfig(config)` | Types `norn.config.ts`. |
| `loadConfig({ cwd?, configPath? })` | Finds, loads and validates the config; resolves with absolute paths (`ResolvedConfig`). Throws with `config` errors. |
| `formatError(error)` | Formats a `NornGenError` as a compiler-style diagnostic. |
| `syncSchedules({ client, project, schedules, dryRun?, prune? })` | Runs `schedules sync` with a Temporal `Client`; resolves with `{ created, updated, unchanged, deleted, conflicts }`. |
| `pullHistories({ client, workflowIds, outDir })` | Runs `histories pull`; resolves with the written file paths. |
| `bundle({ outDir, outFile, codec? })` | Runs `norn bundle`; resolves with `{ code, outFile, workflowsPath }`. |
| `connect(env)` | Connects from the environment variables above; resolves with `{ client, namespace, close() }`. |
| `main(argv, { cwd?, env?, stdout?, stderr?, signal? })` | The CLI itself, resolving with the exit code. `signal` stops `gen --watch` (default: SIGINT and SIGTERM). |

Types: `NornConfig`, `ResolvedConfig`, `LoadConfigOptions`, `GenerateOptions`, `GenerateResult`, `WatchOptions`, `NornGenError`, `NornGenErrorCode`, `NornLock`, `LockedWorkflow`, `CliIo`, `SyncOptions`, `SyncResult`, `ScheduleSpec`, `PullHistoriesOptions`, `BundleOptions`, `ConnectedClient`, `TemporalConnectionSettings`.

### Optional peer dependencies

`schedules sync` and `histories pull` need `@temporalio/client` (and `@temporalio/common`). `bundle` needs `@norn-ts/worker` and `@temporalio/worker`, plus `@norn-ts/codec` for `--codec`. They are optional peer dependencies, loaded only by the commands that use them. `norn gen` needs none of them.
