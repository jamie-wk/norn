# @norn-ts/eslint-plugin

ESLint rules that keep [Norn](https://jamie-wk.github.io/norn/) workflow code deterministic and free of activity imports, so you see problems in your editor instead of at bundle time or on replay.

Workflow code runs inside Temporal's deterministic sandbox: it is replayed from history, has no Node APIs, and must not call activity or service code directly. These rules catch the common mistakes file by file. **`norn gen` still performs the precise checks** (it follows imports across files and knows which classes are workflows); this plugin is the fast, editor-time approximation.

## Install

```sh
pnpm add -D @norn-ts/eslint-plugin eslint @typescript-eslint/parser
```

Requires ESLint 9 or later (flat config) and Node 22.18+.

## Usage

```js
// eslint.config.js
import tsParser from '@typescript-eslint/parser';
import norn from '@norn-ts/eslint-plugin';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tsParser } },
  norn.configs.recommended,
];
```

`configs.recommended` turns on both rules at `error` for the files in `workflowFiles`:

```js
['**/*.workflow.ts', '**/workflows/**/*.ts', '**/.norn/workflows.ts']
```

To lint other files as workflow code, or to set options, configure the rules yourself:

```js
import norn, { workflowFiles } from '@norn-ts/eslint-plugin';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tsParser } },
  {
    files: [...workflowFiles, 'src/flows/**/*.ts'],
    plugins: { norn },
    rules: {
      'norn/workflow-determinism': ['error', { strict: true }],
      'norn/no-activity-imports': ['error', { onlyAllowed: true, allow: ['zod'] }],
    },
  },
];
```

Use `@typescript-eslint/parser` (or another parser that understands TypeScript and TC39 decorators such as `@Workflow()`); the default ESLint parser cannot parse Norn workflow classes.

## Rules

### `norn/workflow-determinism`

Reports APIs in workflow code that are non-deterministic, or that the Temporal workflow sandbox does not provide.

Reported by default:

| Code | Why | Use instead |
| --- | --- | --- |
| `setTimeout(...)` | The sandbox only emulates it with a durable timer; a callback timer is easy to leak | `await sleep(ms)` or `await condition(fn, timeout)` from `@temporalio/workflow` |
| `setInterval`, `setImmediate` | Not available in the sandbox | `await sleep(ms)` (in a loop), `await condition(fn)` |
| `process`, `process.env`, `process.hrtime()`, ... | Not available; host state differs on replay | Workflow input, or read it in an activity |
| `Temporal.Now.*` | Reads the real wall clock: the sandbox patches `Date`, not the TC39 Temporal API | `Temporal.Instant.fromEpochMilliseconds(Date.now())`, `workflowInfo()` timestamps |
| `crypto.randomUUID()`, `crypto.getRandomValues()`, any `crypto.*` | Non-deterministic; Web Crypto is not available | `uuid4()` from `@temporalio/workflow`, `Math.random()` |
| `performance.now()`, any `performance.*` | A real high-resolution clock | `Date.now()` |
| `WeakRef`, `FinalizationRegistry` | Throw `DeterminismViolationError` (GC timing is non-deterministic) | Strong references, workflow state |

`Temporal.Now` is also reported when `Temporal` is imported from `@js-temporal/polyfill` or `temporal-polyfill`. Uses through `globalThis.` / `window.` / `self.` / `global.` are caught too. Locally declared names that shadow a global (`const process = ...`) and TypeScript type positions (`let t: Temporal.Instant`) are ignored.

**About `Date` and `Math.random()`:** inside a Temporal workflow, `Date.now()` and `new Date()` return the deterministic time of the current workflow task, and `Math.random()` is seeded per run so it replays identically. The sandbox patches them, so they are **allowed by default**. Set `strict: true` to report them anyway, for example in code you also want to run outside a workflow.

Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `strict` | `boolean` | `false` | Also report `Date.now()`, `new Date()` / `Date()` with no arguments, and `Math.random()`. `new Date(value)`, `Date.parse` and `Date.UTC` are always allowed. |

```ts
// Incorrect
@Workflow()
export class Reminder {
  async run() {
    // use sleep()
    setTimeout(() => this.remind(), 60_000);
    // pass it in, or use an activity
    const key = process.env.API_KEY;
    // real wall clock
    const at = Temporal.Now.instant();
    // use uuid4()
    return crypto.randomUUID();
  }
}

// Correct
import { sleep, uuid4 } from '@temporalio/workflow';

@Workflow()
export class Reminder {
  async run(input: { apiKey: string }) {
    await sleep('1 minute');
    // Date is deterministic in workflows
    const at = Temporal.Instant.fromEpochMilliseconds(Date.now());
    return uuid4();
  }
}
```

### `norn/no-activity-imports`

Reports imports that load, in workflow code:

1. **Node built-ins**: anything `module.isBuiltin()` accepts (`fs`, `fs/promises`, `node:path`, `crypto`, `node:test`, ...). npm packages that merely start with a built-in's name, such as `buffer/`, are not built-ins.
2. **Packages that cannot run in the workflow sandbox**: the deny list (below, plus `deny`), including subpaths.
3. **Activity and service modules**: specifiers matching `activityPatterns`.
4. **Any other bare package not in the allow list**, but only when `onlyAllowed: true`.

Entries in `allow` win over all of these.

It checks `import` declarations (including side-effect imports like `import 'node:crypto'`), `export ... from` re-exports, `import()` with a static specifier, `require('...')`, and TypeScript `import x = require('...')`.

**Top-level type-only imports are always allowed**: `import type { X } from '...'`, `import type X = require('...')`, `export type { X } from '...'` and `export type * from '...'`.

**Inline `type` specifiers are not enough.** Under `verbatimModuleSyntax`, `import { type X } from 'm'` compiles to `import {} from 'm'` (and `export { type X } from 'm'` to `export {} from 'm'`), which still loads `m`. So when `m` would otherwise be reported, a declaration whose specifiers are *all* inline `type` is reported too, with a message suggesting `import type { ... }` / `export type { ... }`. Inline `type` specifiers from modules that may be loaded (`import { type Duration, ms } from '@norn-ts/core'`) are fine. A mix such as `import { type X, y } from 'fs'` is reported as a normal value import.

**Pattern matching** is done on the import specifier string, not on the resolved file. The specifier is loosely normalized first: `.` and `..` segments are collapsed and leading ones dropped, so `./activities/payments`, `../../src/activities/index.js` and `@acme/app/services/mailer` all match `**/activities/**` or `**/services/**`. Patterns support `**` (any number of segments, including none), `*` and `?` (within one segment) and `{a,b}`. A directory import such as `../activities` matches `**/activities/**`.

Options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `activityPatterns` | `string[]` | see below | Globs for activity/service specifiers. **Replaces** the defaults. |
| `allow` | `string[]` | `[]` | Specifiers that are never reported, added to the built-in allow list. Each entry also allows its subpaths (`zod` allows `zod/v4`). Wins over `deny` and every other check. |
| `deny` | `string[]` | `[]` | Packages that are always reported (with or without `onlyAllowed`), added to the built-in deny list. Each entry also denies its subpaths. |
| `onlyAllowed` | `boolean` | `false` | Report every bare package import that is not allowed. Relative, absolute and `#subpath` imports are not affected (they are still checked against `activityPatterns`). |

Default `activityPatterns` (exported as `defaultActivityPatterns`):

```js
['**/activities/**', '**/services/**', '**/*.activities', '**/*.activities.ts', '**/*.activities.js',
 '**/*.service', '**/*.service.ts', '**/*.service.js']
```

Built-in allow list (exported as `defaultAllow`): `@temporalio/workflow`, `@temporalio/common`, `@norn-ts/workflow`, `@norn-ts/core`.

Built-in deny list (exported as `defaultDeny`): `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, `@norn-ts/activity`, `@norn-ts/worker`, `@norn-ts/client`, `@norn-ts/testing`, `@norn-ts/hono`, `@norn-ts/cli`. These depend on Node, the network or worker internals; use them from activities, the worker or the client. To permit one anyway, list it in `allow`.

```ts
// Incorrect
import { readFileSync } from 'node:fs';
import { charge } from './activities/payments.ts';
import { Mailer } from '../services/mailer.service.ts';
// deny list
import { Connection } from '@temporalio/client';
// still loads node:fs; use `import type`
import { type Stats } from 'node:fs';

// Correct
import type { PaymentActivities } from './activities/payments.ts';
import { Workflow, useActivities } from '@norn-ts/workflow';
// an activity contract, not the implementation
import { payments } from './registry.ts';

@Workflow()
export class Orders {
  private readonly pay = useActivities(payments);
  async run() {
    return this.pay.charge('order-1', 100);
  }
}
```

With `{ onlyAllowed: true, allow: ['zod'] }`, `import _ from 'lodash'` is reported while `import { z } from 'zod'` and `import { sleep } from '@temporalio/workflow'` are not.

## Exports

```ts
import norn, { workflowFiles, defaultActivityPatterns, defaultAllow, defaultDeny } from '@norn-ts/eslint-plugin';
import type { WorkflowDeterminismOptions, NoActivityImportsOptions } from '@norn-ts/eslint-plugin';

// { name: '@norn-ts/eslint-plugin', version }
norn.meta;
// { 'workflow-determinism', 'no-activity-imports' }
norn.rules;
// flat config object
norn.configs.recommended;
```

## License

MIT
