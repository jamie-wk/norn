---
title: "@norn-ts/eslint-plugin"
description: "ESLint rules that keep workflow code deterministic and free of activity imports."
sidebar:
  order: 11
---

ESLint rules that keep Norn workflow code deterministic and free of activity imports, so you see problems in your editor instead of at bundle time or on replay. For setup in a project, see [ESLint rules](/norn/guides/eslint/).

Workflow code runs inside Temporal's deterministic sandbox: it is replayed from history, has no Node APIs, and must not call activity or service code directly. These rules catch the common mistakes file by file.

:::note
`norn gen` still performs the precise checks: it follows imports across files and knows which classes are workflows. This plugin is the fast, editor-time approximation. See [`@norn-ts/cli`](/norn/reference/cli/).
:::

## Install

```sh
pnpm add -D @norn-ts/eslint-plugin eslint @typescript-eslint/parser
```

Requires ESLint 9 or later (flat config; `eslint >=9` is a peer dependency) and Node 22.18+.

## Configuration

```js
// eslint.config.js
import tsParser from '@typescript-eslint/parser';
import norn from '@norn-ts/eslint-plugin';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tsParser } },
  norn.configs.recommended,
];
```

`configs.recommended` (named `@norn-ts/eslint-plugin/recommended`) turns on both rules at `error` for the files in `workflowFiles`:

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

Use `@typescript-eslint/parser`, or another parser that understands TypeScript and TC39 decorators such as `@Workflow()`. The default ESLint parser cannot parse Norn workflow classes.

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

`Temporal.Now` is also reported when destructured (`const { Now } = Temporal`), and when `Temporal` is imported from `@js-temporal/polyfill` or `temporal-polyfill` (or their subpaths). Uses through `globalThis.`, `window.`, `self.` and `global.` are caught too. Locally declared names that shadow a global (`const process = ...`) and TypeScript type positions (`let t: Temporal.Instant`) are ignored.

:::note[Date and Math.random()]
Inside a Temporal workflow, `Date.now()` and `new Date()` return the deterministic time of the current workflow task, and `Math.random()` is seeded per run so it replays identically. The sandbox patches them, so they are **allowed by default**. Set `strict: true` to report them anyway, for example in code you also want to run outside a workflow.
:::

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
```

```ts
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

It checks `import` declarations (including side-effect imports like `import 'node:crypto'`), `export ... from` re-exports, `import()` with a static specifier, `require('...')` (unless `require` is a locally declared name), and TypeScript `import x = require('...')`.

**Top-level type-only imports are always allowed**: `import type { X } from '...'`, `import type X = require('...')`, `export type { X } from '...'` and `export type * from '...'`.

**Inline `type` specifiers are not enough.** Under `verbatimModuleSyntax`, `import { type X } from 'm'` compiles to `import {} from 'm'` (and `export { type X } from 'm'` to `export {} from 'm'`), which still loads `m`. So when `m` would otherwise be reported, a declaration whose specifiers are *all* inline `type` is reported too, with a message suggesting `import type { ... }` / `export type { ... }`. Inline `type` specifiers from modules that may be loaded (`import { type Duration, ms } from '@norn-ts/core'`) are fine. A mix such as `import { type X, y } from 'fs'` is reported as a normal value import.

**Pattern matching** is done on the import specifier string, not on the resolved file. The specifier is loosely normalized first: `.` and `..` segments are collapsed and leading ones dropped, so `./activities/payments`, `../../src/activities/index.js` and `@acme/app/services/mailer` all match `**/activities/**` or `**/services/**`. Patterns support `**` (any number of segments, including none), `*` and `?` (within one segment) and `{a,b}`. A directory import such as `../activities` matches `**/activities/**`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `activityPatterns` | `string[]` | `defaultActivityPatterns` | Globs for activity and service specifiers. **Replaces** the defaults. |
| `allow` | `string[]` | `[]` | Specifiers that are never reported, added to the built-in allow list. Each entry also allows its subpaths (`zod` allows `zod/v4`). Wins over `deny` and every other check. |
| `deny` | `string[]` | `[]` | Packages that are always reported (with or without `onlyAllowed`), added to the built-in deny list. Each entry also denies its subpaths. |
| `onlyAllowed` | `boolean` | `false` | Report every bare package import that is not allowed. Relative, absolute, `#subpath` and URL-scheme imports are not affected (they are still checked against `activityPatterns`). |

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
```

```ts
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
import type { NornPlugin, WorkflowDeterminismOptions, NoActivityImportsOptions } from '@norn-ts/eslint-plugin';

// { name: '@norn-ts/eslint-plugin', version }
norn.meta;
// { 'workflow-determinism', 'no-activity-imports' }
norn.rules;
// flat config object
norn.configs.recommended;
```

| Export | Kind |
| --- | --- |
| `default` (`norn`) | The plugin: `meta`, `rules`, `configs.recommended` |
| `workflowFiles` | Globs the recommended config treats as workflow code |
| `defaultActivityPatterns`, `defaultAllow`, `defaultDeny` | `no-activity-imports` defaults |
| `NornPlugin`, `WorkflowDeterminismOptions`, `NoActivityImportsOptions` | Types |
