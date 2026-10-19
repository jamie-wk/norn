# The norn CLI

`@norn/cli` provides the `norn` command. Install it as a dev dependency and run it through your package manager (`pnpm norn gen`, `npx norn gen`).

```sh
pnpm add -D @norn/cli
norn --help
```

<!-- VERIFY: reconcile every command, flag and output on this page with packages/cli/README.md once it lands -->

| Command | What it does |
| --- | --- |
| `norn gen` | Generates `.norn/` from your decorated classes and checks them. |
| `norn bundle` | Builds the production workflow bundle. |
| `norn schedules sync` | Creates, updates and removes Temporal schedules to match `@Schedule` declarations. |
| `norn histories pull` | Downloads workflow histories for replay tests. |

Exit codes: `0` on success, `1` when the command ran and found problems (generation errors, stale files), `2` for usage errors (unknown command or flag).

## `norn gen`

```sh
norn gen                    # write .norn/ and norn.lock.json
norn gen --check            # verify generated files are current; write nothing; exit 1 if stale
norn gen --watch            # regenerate on every change
norn gen --accept-rename    # accept removed or renamed workflow types, handlers and activities
norn gen --config path/to/norn.config.ts
```

`--check` and `--watch` can't be combined. On success it lists the files it wrote, or says everything is up to date. On failure it prints every problem as a compiler-style diagnostic and exits 1:

```text
src/workflows/order.workflow.ts:10:5 - error norn(determinism): setTimeout() is not available in workflow code
  hint: use sleep() or condition() from @temporalio/workflow
```

See [Project layout & codegen](/guide/project-layout) for what is generated and why.

### Diagnostics

| Code | Meaning |
| --- | --- |
| `config` | `norn.config.ts` is missing a default export, has unknown options or invalid values. |
| `parse-error` | A source file has a syntax error. |
| `non-literal` | A decorator option isn't a literal (a variable, call, spread or template with expressions). |
| `invalid-option` | A decorator option has an invalid value: empty task queue, bad workflow name, unknown search attribute type, bad cron expression or overlap policy, bad scope. |
| `invalid-decorator` | A decorator is misused: called without parentheses, `@Schedule` without `@Workflow`, a class with both `@Workflow` and `@Activities`, an `@Activities` class with no `@Activity` methods. |
| `invalid-member` | A handler or activity decorator is on a private, static or symbol-named member. |
| `invalid-validate` | `@Validate` names a method that isn't an `@Update`, or an update has more than one validator. |
| `missing-run` | A `@Workflow` class has no `run()` method. |
| `not-exported` | A decorated class isn't a named export. |
| `missing-annotation` | An injectable constructor parameter has no type annotation. |
| `unsupported-type` | A constructor parameter type can't be injected: primitive, union, generic or rest parameter. |
| `unresolved-type` | A constructor parameter type can't be found (not imported, or the import doesn't resolve). |
| `interface-without-token` | A parameter is typed with an interface that has no same-named token. |
| `duplicate-workflow`, `duplicate-handler`, `duplicate-activity`, `duplicate-class`, `duplicate-schedule` | Two declarations register the same name. |
| `search-attribute-conflict` | Two workflows declare the same search attribute with different types. |
| `import-boundary` | Workflow code (or a module it imports, transitively) imports activity or service code, a Node built-in, or a worker-side package. `import type` is always fine. |
| `determinism` | Workflow code uses a sandbox-unsafe global: `setTimeout`, `setInterval`, `setImmediate`, `process`, `Temporal.Now`, `crypto`, `performance`, `WeakRef`, `FinalizationRegistry`. |
| `lock-removed` | A name in `norn.lock.json` disappeared, or a workflow changed task queue. Use `--accept-rename` if intended. |
| `lock-invalid` | `norn.lock.json` can't be read. |

### `norn.config.ts`

```ts
import { defineConfig } from '@norn/cli';

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
| `include` | `['src/**/*.ts']` | Source globs to scan. |
| `exclude` | test files, `.d.ts`, `node_modules` | Globs to skip. |
| `outDir` | `'.norn'` | Where generated files go. |
| `providers` | none | A module exporting `export const providers = [provide(...), ...]`. |
| `importExtension` | `'.js'` | Extension used in generated relative imports. Use `'.ts'` with `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`. |
| `contracts.outFile` | none | Also write the contracts to this file, such as a package shared with API code. |

Paths are relative to the config file. `norn` finds the nearest `norn.config.ts` (or `.mts`, `.js`, `.mjs`) at or above the working directory; without one it uses the defaults with the working directory as the root. The config file is loaded with Node's built-in TypeScript support, which is one reason Norn requires Node 22.18+.

## `norn bundle`

```sh
norn bundle --out dist/workflow-bundle.js
```

Bundles the registry's workflows with Norn's bundler settings (the same as [`bundleWorkflows()`](/reference/worker#bundleworkflows)) and writes a file for `NORN_WORKFLOW_BUNDLE`. It asks you to run `norn gen` first if the workflows barrel is missing. See [Worker & deployment](/guide/worker#production-builds-compile-then-bundle).

<!-- VERIFY: norn bundle flags (--out name, payload converter path for @norn/codec, plugins) -->

## `norn schedules sync`

```sh
norn schedules sync --dry-run
norn schedules sync
```

Reads `.norn/schedules.json` and makes the namespace's schedules match it. Connects with `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY`. See [Schedules](/guide/schedules).

<!-- VERIFY: schedules sync flags beyond --dry-run -->

## `norn histories pull`

```sh
norn histories pull <workflowId...> --out test/histories
```

Downloads the event history of each workflow ID as `<workflowId>.json`, in the format `loadHistories()` reads. A workflow ID is required. See [Replay tests](/guide/versioning#replay-tests).

<!-- VERIFY: histories pull arguments and flags (--out, --run-id, --query/--limit, namespace) -->
