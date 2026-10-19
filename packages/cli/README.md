# @norn-ts/cli

The `norn` command for [Norn](https://jamie-wk.github.io/norn/) projects. It reads your `@Workflow`, `@Activities` and `@Service` classes and generates the glue Temporal needs: the workflow bundle entry, workflow-safe activity references, typed contracts for API code, the dependency-injection container and the worker registry. It also checks that workflow code stays inside the sandbox, keeps a lock file of every name in-flight executions depend on, syncs `@Schedule`s to Temporal, pulls histories for replay tests and bundles workflows for production.

`norn gen` never runs your code. It parses the TypeScript source with [oxc](https://oxc.rs) and reads decorators syntactically, so it is fast, works before anything compiles, and cannot trigger side effects. The price is that decorator options must be literals (see [Decorator options are literals](#decorator-options-are-literals)).

```sh
pnpm add -D @norn-ts/cli
```

Requires Node 22.18+ (for `norn.config.ts`, loaded with Node's built-in TypeScript type stripping).

| Command | What it does |
| --- | --- |
| [`norn gen`](#norn-gen) | Generate `.norn/` and `norn.lock.json`; `--check` in CI, `--watch` while developing |
| [`norn schedules sync`](#norn-schedules-sync) | Create, update and prune Temporal schedules declared with `@Schedule` |
| [`norn histories pull`](#norn-histories-pull) | Download workflow histories as JSON for replay tests |
| [`norn bundle`](#norn-bundle) | Bundle the generated workflows for production workers |

Exit codes: `0` success, `1` errors (or stale files with `--check`), `2` usage error. `norn --help`, `norn <command> --help` and `norn --version` do what you expect.

## Configuration

`norn.config.ts` is found by walking up from the working directory (`norn.config.mts`, `.js` and `.mjs` work too), or passed with `--config <path>`. Paths in it are relative to the config file, whose directory is the **project root**. Without a config file the working directory is the root and every option takes its default.

```ts
// norn.config.ts
import { defineConfig } from '@norn-ts/cli';

export default defineConfig({
  include: ['src/**/*.ts'],
  providers: 'src/providers.ts',
  contracts: { outFile: '../contracts/src/index.ts' },
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `include` | `['src/**/*.ts']` | Globs of source files to scan. Patterns may climb out of the root (`'../shared/**/*.ts'`). |
| `exclude` | `['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts', '**/node_modules/**']` | Globs to skip. `outDir` and `contracts.outFile` are always skipped. |
| `outDir` | `'.norn'` | Where generated files are written. |
| `providers` | none | A module with `export const providers = [provide(...), ...]`, passed to the container. `norn gen` checks that it exists and has that export. |
| `importExtension` | `'.js'` | Extension of relative imports in generated files. Use `'.ts'` with `allowImportingTsExtensions` or when running sources directly. |
| `contracts.outFile` | none | Also write the contracts here, with imports relative to that file, e.g. into a package shared with API code. |

Unknown options and wrong types are reported as `config` errors.

## norn gen

```sh
norn gen                   # write everything that changed
norn gen --check           # CI: exit 1 if anything is missing or stale, write nothing
norn gen --watch           # regenerate on every change to a .ts file under the root
norn gen --accept-rename   # accept names removed from norn.lock.json
```

`norn gen` only rewrites files whose content changed, and its output is deterministic: entries are sorted and formatting is stable, so generated files diff cleanly. Commit `norn.lock.json`; whether you commit `.norn/` is up to you (`norn gen --check` in CI works either way).

On any error nothing is written. Every error is printed, compiler-style, with its location and a hint:

```
src/workflows/order.ts:14:7 - error norn(determinism): setTimeout in workflow code: the sandbox only emulates it with a durable timer, and a callback timer easily outlives the code that needed it
  hint: Use await sleep(ms) from '@temporalio/workflow', or await condition(() => ..., timeout).

Found 1 error.
```

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

`norn gen` writes the following files (every `.ts` file starts with `// Generated by norn gen. Do not edit.`):

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

Only `import type` of activity classes, so workflow bundles never contain activity code. `@Activity` options are copied as written; `@NonRetryable([X])` on the method (or else the class) adds `nonRetryable: ['X']` by class name. `@NonRetryable()` without arguments adds nothing here: the worker applies it at runtime.

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

`import type` only. Handler maps go from method name to registered name, so `client.workflow(OrderWorkflow).signal('transferEvent', ...)` sends `transfer-event`. Inherited handlers (from a base class that `norn gen` can find through relative imports) are included.

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

The name is resolved through the file's imports (following re-exports and `index.ts` files, mapping `.js` specifiers to `.ts` sources) to the module that declares the value, and imported from there. Names from packages (`import { Pool } from 'pg'`) are imported from the package as-is; namespace-qualified types (`db: tokens.Db`) work too. Same-named keys from different modules get aliases (`Config$1`).

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

Use it with `createWorker({ registry })` from `@norn-ts/worker`.

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

One entry per `@Schedule` (a class decorator on a `@Workflow` class; a class can have several), sorted by id. The id defaults to the workflow type name in kebab case (`ReportWorkflow` → `report-workflow`), as documented on `@Schedule`.

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

#### `norn.lock.json` (project root, commit it)

Every workflow type, its task queue and handler names, and every activity name:

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

New names are added silently. When a locked workflow type, signal, query, update or activity name disappears, or a workflow's task queue changes, `norn gen` fails, because executions already running would break: their next workflow task finds no registered type, signals and updates from existing callers are rejected, scheduled activities have no worker, or tasks wait on the old queue. If the change is intentional (nothing in flight, or you migrated), run `norn gen --accept-rename` to update the lock.

```
norn.lock.json - error norn(lock-removed): signal "pause" of OrderWorkflow was removed or renamed; in-flight executions (and callers) still send "pause", which would be rejected or dropped
  hint: If this is intentional (no executions in flight, or they were migrated), run norn gen --accept-rename to update norn.lock.json.
```

### Decorator options are literals

Because `norn gen` does not execute code, decorator options must be written inline as literals: strings, numbers (including negative), booleans, `null`, template literals without `${}`, and arrays or objects of those (`as const` and `satisfies` are fine). The exceptions:

- **class or token references by name** where a class is expected: `inject: [Db, Config]`, `provides: TransferService`, `failOn: [InvalidOrderError]` and `@NonRetryable([InvalidCardError])`;
- **functions** for `dedupeBy` (recorded as present; never evaluated).

```
src/workflows.ts:5:24 - error norn(non-literal): @Workflow option "taskQueue" must be a literal (a string, number, boolean, null, or an array or object of literals); found identifier QUEUE
  hint: norn gen reads decorators without running your code, so options must be written inline as literals: replace QUEUE with its value.
```

Decorators are recognized when imported by name from `@norn-ts/workflow` or `@norn-ts/activity`, including aliases (`import { Workflow as W }`) and namespace imports (`@nw.Workflow(...)`). Decorators re-exported through your own modules are not recognized.

### Checks

All problems are collected and reported together, each with `file:line:col`.

| Code | Meaning |
| --- | --- |
| `config` | Invalid `norn.config.ts`, or a `providers` module that is missing or has no `providers` export. |
| `parse-error` | A source file does not parse. |
| `non-literal` | A decorator option is not a literal (see above). |
| `invalid-option` | A known option has the wrong type or value (`taskQueue: ''`, an invalid workflow `name`, unknown search attribute types, `versioning`, cron expressions, `overlap`, `scope`, activity durations and retries, ...) or an option does not exist. |
| `invalid-decorator` | A decorator factory is used without calling it (`@Signal` instead of `@Signal()`), `@Schedule` on a class without `@Workflow`, a class with two of `@Workflow` / `@Activities` / `@Service`, an `@Activities` class without `@Activity` methods, or a member decorator in the wrong kind of class. |
| `invalid-member` | A handler or activity decorator on a private (`#x`), static, non-method or computed member. |
| `invalid-validate` | `@Validate('x')` where `x()` is not an `@Update` method, or an update with more than one validator. |
| `missing-run` | A `@Workflow` class (with its base classes) has no `run()` method. |
| `not-exported` | A decorated class, or a locally declared dependency, is not a named export. |
| `missing-annotation` | A constructor parameter has no type annotation and the decorator has no `inject`. |
| `unsupported-type` | A parameter type cannot identify a dependency: primitive (`string`), union, intersection, generic (`Repo<User>`), rest parameter, default/namespace import. Use `inject: [token]`. |
| `unresolved-type` | The type is neither imported nor declared, or its relative import does not resolve to a file. |
| `interface-without-token` | The type is only an interface or type alias, with no same-named value to inject. Add `export const X = token<X>('X')`. |
| `duplicate-workflow` | Two workflows with the same type name. |
| `duplicate-handler` | Two signals, queries or updates of one workflow with the same registered name. |
| `duplicate-activity` | Two activities with the same name (prefix + name), in one class or across classes. |
| `duplicate-class` | Two `@Activities` classes with the same class name (both would be exported from `activities.ts`). |
| `duplicate-schedule` | Two schedules with the same id. |
| `search-attribute-conflict` | The same search attribute declared with different types by different workflows. |
| `import-boundary` | Workflow code loads something the workflow sandbox cannot run (below). |
| `determinism` | Workflow code uses a non-deterministic or unavailable global (below). |
| `lock-removed` | A name in `norn.lock.json` disappeared, or a task queue changed. |
| `lock-invalid` | `norn.lock.json` cannot be read. |

**Import boundaries.** Workflow code is every file with a `@Workflow` class plus every relative module it loads, transitively (a helper that imports an activity file is caught at the helper's import, with the import chain in the message). Workflow code must not load:

- a file that declares `@Activities` or `@Service` classes;
- a Node built-in (`fs`, `node:crypto`, ...);
- `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, `@norn-ts/activity`, `@norn-ts/worker`, `@norn-ts/client`, `@norn-ts/testing`, `@norn-ts/hono` or `@norn-ts/cli` (or their subpaths).

`import type` and `export type` are fine. `import { type X } from '...'` is **not**: with only inline `type` specifiers, `verbatimModuleSyntax` keeps it as `import {} from '...'`, which still loads the module. `export ... from` and dynamic `import('...')` count as imports.

```
src/workflows/order.ts:2:1 - error norn(import-boundary): Workflow code must not import src/activities/payment.ts, which declares @Activities or @Service classes
  hint: Use import type for types; workflows call activities through the generated activities file with useActivities().
```

**Determinism.** In workflow code, references to the globals `setTimeout` (use `sleep()`), `setInterval`, `setImmediate`, `process`, `Temporal.Now`, `crypto`, `performance`, `WeakRef` and `FinalizationRegistry` are errors, including through `globalThis.` / `window.` / `self.` / `global.` and `const { Now } = Temporal`. Local variables (including hoisted `var`s), parameters and imports with those names are respected, and `Temporal` imported from `@js-temporal/polyfill` or `temporal-polyfill`, under any name, is still checked. `Date.now()` and `Math.random()` are fine: the sandbox makes them deterministic. For editor feedback, use the rules in `@norn-ts/eslint-plugin`.

### Limits of syntax-only analysis

- Inheritance is followed through base classes declared in the same file or imported from relative modules; bases from packages are not read.
- TypeScript `paths` aliases are treated like package names: imported as-is in `container.ts`, and not followed by the import-boundary check.
- Dependencies imported from packages are assumed to be values; `norn gen` does not read `.d.ts` files.

## norn schedules sync

```sh
norn schedules sync              # create missing, update changed, leave unchanged schedules
norn schedules sync --dry-run    # print the plan only
norn schedules sync --prune      # also delete this project's norn-managed schedules that are no longer declared
```

Reads `<outDir>/schedules.json` (run `norn gen` first) and connects using:

| Variable | Default | |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_API_KEY` | none | API key auth; enables TLS |
| `TEMPORAL_TLS_CERT`, `TEMPORAL_TLS_KEY` | none | Client certificate and key file paths for mTLS (set both) |
| `TEMPORAL_TLS` | none | `true` to use TLS without either of the above |

Schedules created by `norn` carry the memo `{ nornManaged: '<name>' }`, where `<name>` is the `name` in the `package.json` next to `norn.config.ts`, so projects can share a namespace. A declared id that already exists **without** this project's memo is reported as a conflict (exit 1) and left alone, and `--prune` only ever deletes this project's managed schedules. To detect changes, the workflow action carries a hash of the declared spec in its memo (`nornScheduleHash`); a schedule is updated when the hash differs, so manual edits in the Temporal UI are kept until the declaration changes. `overlap` maps to Temporal's `ScheduleOverlapPolicy` (`'buffer-one'` → `BUFFER_ONE`, default `SKIP`); the schedule's input becomes the workflow's single argument.

```
created    nightly-report
unchanged  report-workflow
1 created, 0 updated, 1 unchanged, 0 deleted in namespace default.
```

`--prune` relies on Temporal's schedule listing, which is eventually consistent: a schedule created a moment ago may not be listed yet.

## norn histories pull

```sh
norn histories pull order-123 order-456 --out test/histories
```

Writes `<out>/<workflowId>.json` (default `histories/`; characters unsafe in file names become `_`) with the latest run's event history, in the JSON format of `historyToJSON`. Use the files in replay tests to catch non-deterministic changes before you deploy:

```ts
import { readFile } from 'node:fs/promises';
import { Worker } from '@temporalio/worker';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils.js';
import { bundleWorkflows } from '@norn-ts/worker';
import { registry } from '../.norn/registry.js';

const history = historyFromJSON(JSON.parse(await readFile('test/histories/order-123.json', 'utf8')));
await Worker.runReplayHistory({ workflowBundle: await bundleWorkflows(registry) }, history);
```

Connects like `norn schedules sync`.

## norn bundle

```sh
norn bundle                                   # dist/workflow-bundle.js
norn bundle --out build/workflows.js --codec  # with @norn-ts/codec's payload converter
```

Bundles `<outDir>/workflows.ts` (or `workflows.js` if you compiled `.norn/`) with `bundleWorkflows()` from `@norn-ts/worker`: standard decorators, `.js`→`.ts` resolution and Norn's workflow interceptors (correlation IDs). `--codec` adds `payloadConverterPath` from `@norn-ts/codec`, which workers using `createDataConverter()` need. Point workers at the file with `workflowBundle: { codePath }` or the `NORN_WORKFLOW_BUNDLE` environment variable.

## Programmatic API

```ts
import { generate, watch, defineConfig, formatError } from '@norn-ts/cli';

const result = await generate({ cwd, configPath, check, acceptRename, write });
// { files: Record<path, content>, written: string[], stale: string[], errors: NornGenError[], root }
for (const error of result.errors) console.error(formatError(error));

const controller = new AbortController();
await watch({ cwd, signal: controller.signal, debounceMs: 100, onResult: (r) => console.log(r.written) });
```

- `generate(options)`: paths in the result are relative to the project root. `check: true` compares with disk and writes nothing; `write: false` renders without writing.
- `watch(options)`: generates, then regenerates on changes until `signal` aborts; resolves when stopped.
- `loadConfig(options)`, `defineConfig(config)`.
- `syncSchedules({ client, project, schedules, dryRun, prune })`, `pullHistories({ client, workflowIds, outDir })`, `bundle({ outDir, outFile, codec })`, `connect(env)`.
- `main(argv, { cwd, env, stdout, stderr, signal })`: the CLI itself, resolving with the exit code.

`schedules sync` and `histories pull` need `@temporalio/client` (and `@temporalio/common`); `bundle` needs `@norn-ts/worker` and `@temporalio/worker` (plus `@norn-ts/codec` for `--codec`). They are optional peer dependencies, loaded only by the commands that use them.
