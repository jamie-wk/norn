# ESLint rules

`@norn/eslint-plugin` reports workflow-sandbox mistakes in your editor, as you type. `norn gen` performs the precise checks (it follows imports across files and knows exactly which classes are workflows); the ESLint rules are the fast, file-by-file approximation that catches most problems before you save.

```sh
pnpm add -D @norn/eslint-plugin eslint @typescript-eslint/parser
```

Requires ESLint 9+ (flat config).

```js
// eslint.config.js
import tsParser from '@typescript-eslint/parser';
import norn from '@norn/eslint-plugin';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tsParser } },
  norn.configs.recommended,
];
```

Use `@typescript-eslint/parser` (or another parser that understands TypeScript and TC39 decorators); ESLint's default parser can't parse decorated classes.

`configs.recommended` turns both rules on, as errors, for the files in `workflowFiles`:

```js
['**/*.workflow.ts', '**/workflows/**/*.ts', '**/.norn/workflows.ts']
```

To cover other files or pass options, configure the rules yourself:

```js
import norn, { workflowFiles } from '@norn/eslint-plugin';

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

## `norn/workflow-determinism`

Reports APIs that are non-deterministic, or that the workflow sandbox doesn't provide:

| Code | Use instead |
| --- | --- |
| `setTimeout(...)` | `await sleep(ms)` or `await condition(fn, timeout)` from `@temporalio/workflow` |
| `setInterval`, `setImmediate` | `sleep()` in a loop, `condition()` |
| `process`, `process.env`, ... | Workflow input, or read it in an activity |
| `Temporal.Now.*` | `Temporal.Instant.fromEpochMilliseconds(Date.now())`, `workflowInfo()` timestamps |
| `crypto.randomUUID()`, any `crypto.*` | `uuid4()` from `@temporalio/workflow`, `Math.random()` |
| `performance.now()`, any `performance.*` | `Date.now()` |
| `WeakRef`, `FinalizationRegistry` | Strong references, workflow state |

Uses through `globalThis.`, `window.`, `self.` and `global.` are caught, as is `Temporal.Now` from `@js-temporal/polyfill` or `temporal-polyfill`. Local variables that shadow a global, and type positions (`let t: Temporal.Instant`), are ignored.

`Date.now()`, `new Date()` and `Math.random()` are **allowed by default**, because the sandbox makes them deterministic. With `{ strict: true }` the rule reports them too (`new Date(value)`, `Date.parse` and `Date.UTC` stay allowed), for code you also run outside workflows.

## `norn/no-activity-imports`

Reports imports that would load, in workflow code:

1. **Node built-ins**: anything `module.isBuiltin()` accepts (`fs`, `fs/promises`, `node:test`, ...).
2. **Packages that can't run in the sandbox**: `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, `@norn/activity`, `@norn/worker`, `@norn/client`, `@norn/testing`, `@norn/hono`, `@norn/cli` (and their subpaths), plus your `deny` list.
3. **Activity and service modules**: specifiers matching `activityPatterns`.
4. **Any other bare package not allowed**, only with `onlyAllowed: true`.

**Top-level `import type` is always allowed.** Inline type specifiers are not enough: under `verbatimModuleSyntax`, `import { type Mailer } from '../services/mailer.js'` compiles to `import {} from '../services/mailer.js'`, which still loads the module, so it is reported with a suggestion to write `import type { Mailer }`.

| Option | Default | Description |
| --- | --- | --- |
| `activityPatterns` | see below | Globs matched against the import specifier. **Replaces** the defaults. |
| `allow` | `[]` | Specifiers never reported, added to the built-in allow list (`@temporalio/workflow`, `@temporalio/common`, `@norn/workflow`, `@norn/core`). Each also allows its subpaths. Wins over everything. |
| `deny` | `[]` | Packages always reported, added to the built-in deny list. |
| `onlyAllowed` | `false` | Report every bare package import that isn't allowed. |

Default `activityPatterns`:

```js
['**/activities/**', '**/services/**', '**/*.activities', '**/*.activities.ts', '**/*.activities.js',
 '**/*.service', '**/*.service.ts', '**/*.service.js']
```

Matching is done on the specifier string, loosely normalised (`.` and `..` segments collapsed), so `../activities/payments.js` and `@acme/app/services/mailer` both match.

```ts
// Reported
import { readFileSync } from 'node:fs';
import { PaymentActivities } from '../activities/payment.activities.js'; // use .norn/activities.js
import { Connection } from '@temporalio/client';

// Fine
import type { PaymentActivities as PaymentActivitiesClass } from '../activities/payment.activities.js';
import { PaymentActivities } from '../../.norn/activities.js';
import { Workflow, useActivities } from '@norn/workflow';
import { sleep } from '@temporalio/workflow';
```

The full option reference is in the [package README](https://github.com/jamie-wk/norn/tree/main/packages/eslint-plugin#readme).
