import plugin from '../src/index.ts';
import { ruleTester } from './rule-tester.ts';

const rule = plugin.rules['no-activity-imports'];

ruleTester.run('no-activity-imports', rule, {
  valid: [
    // Workflow-safe packages and plain relative modules.
    `import { sleep, condition } from '@temporalio/workflow';`,
    `import { ApplicationFailure } from '@temporalio/common';`,
    `import { Workflow, Signal, useActivities } from '@norn-ts/workflow';`,
    `import { payments } from './registry.ts';`,
    `import { orderContract } from '../contracts/orders.js';`,
    // Names that only resemble the activity/service patterns.
    `import { log } from './activity-log.ts';`,
    `import { registry } from './services-registry.ts';`,
    `import { serviceName } from './service-names.ts';`,
    // Other bare packages are allowed unless `onlyAllowed` is on.
    `import { z } from 'zod';`,
    `import ms from 'ms';`,
    // npm packages named like built-ins are not built-ins.
    `import { Buffer } from 'buffer/';`,
    `import punycode from 'punycode/punycode.js';`,
    // Top-level `import type` / `export type` are erased at compile time, whatever the module.
    `import type { Stats } from 'node:fs';`,
    `import type * as fs from 'fs';`,
    `import type { Mailer } from '../services/mailer.service.ts';`,
    `export type { ChargeResult } from './activities/payments';`,
    `export type * from './payments.activities.ts';`,
    `import type Fs = require('fs');`,
    `import type { Client } from '@temporalio/client';`,
    `import type { ActivityContext } from '@norn-ts/activity';`,
    // Inline `type` specifiers are fine when the module itself may be loaded.
    `import { type ActivityRef } from './registry.ts';`,
    `import { type Duration, ms } from '@norn-ts/core';`,
    `export { type Contract } from './contracts.ts';`,
    // Decorated workflow class that imports activity *types* only.
    `
import type { PaymentActivities } from './activities/payments.ts';
import { Workflow, useActivities } from '@norn-ts/workflow';
import { payments } from './registry.ts';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  private readonly pay = useActivities(payments);
  async run(): Promise<ReturnType<PaymentActivities['charge']>> { return this.pay.charge('o-1', 100); }
}
`,
    // require/import() with a dynamic specifier, member `require`, or a shadowed `require` are not checked.
    `export const load = (name: string) => require(name);`,
    `export const load = (name: string) => import(name);`,
    `declare const loader: { require(id: string): unknown }; loader.require('fs');`,
    `export function f(require: (id: string) => unknown) { return require('fs'); }`,
    `const x = require('lodash'); export { x };`,
    // Custom patterns replace the defaults.
    { code: `import { charge } from './activities/payments';`, options: [{ activityPatterns: ['**/io/**'] }] },
    // `onlyAllowed`: everything in the default or configured allow list (and its subpaths) passes.
    { code: `import { sleep } from '@temporalio/workflow';`, options: [{ onlyAllowed: true }] },
    { code: `import { x } from '@temporalio/workflow/lib/interfaces';`, options: [{ onlyAllowed: true }] },
    { code: `import { Duration } from '@norn-ts/core';`, options: [{ onlyAllowed: true }] },
    { code: `import { payments } from './registry.ts';`, options: [{ onlyAllowed: true }] },
    { code: `import { z } from 'zod'; import { y } from 'zod/v4';`, options: [{ onlyAllowed: true, allow: ['zod'] }] },
    { code: `import type { Big } from 'big.js';`, options: [{ onlyAllowed: true }] },
    // Specifiers in `allow` are never reported, and win over the deny list.
    { code: `import assert from 'node:assert';`, options: [{ allow: ['node:assert'] }] },
    { code: `import { MockActivityEnvironment } from '@temporalio/testing';`, options: [{ allow: ['@temporalio/testing'] }] },
    { code: `import { x } from '@acme/io/helpers';`, options: [{ deny: ['@acme/io/client'] }] },
    // Package names that merely start with a denied name.
    `import { x } from '@temporalio/client-extra';`,
    `import { x } from '@norn-ts/workflow-utils';`,
  ],
  invalid: [
    // Node built-ins, with and without the node: prefix, including subpaths and node:-only modules.
    { code: `import fs from 'fs';`, errors: [{ messageId: 'builtin', data: { source: 'fs' } }] },
    { code: `import { readFile } from 'node:fs/promises';`, errors: [{ messageId: 'builtin', data: { source: 'node:fs/promises' } }] },
    { code: `import * as path from 'path';`, errors: [{ messageId: 'builtin', data: { source: 'path' } }] },
    { code: `import { randomUUID } from 'crypto';`, errors: [{ messageId: 'builtin', data: { source: 'crypto' } }] },
    { code: `import { spawn } from 'child_process';`, errors: [{ messageId: 'builtin', data: { source: 'child_process' } }] },
    { code: `import http from 'node:http';`, errors: [{ messageId: 'builtin', data: { source: 'node:http' } }] },
    { code: `import { test } from 'node:test';`, errors: [{ messageId: 'builtin', data: { source: 'node:test' } }] },
    { code: `import 'node:crypto';`, errors: [{ messageId: 'builtin', data: { source: 'node:crypto' } }] },
    // A value specifier next to a type specifier still loads the module.
    { code: `import { type Stats, readFileSync } from 'fs';`, errors: [{ messageId: 'builtin', data: { source: 'fs' } }] },
    { code: `import fs, { type Stats } from 'fs';`, errors: [{ messageId: 'builtin', data: { source: 'fs' } }] },
    // Re-exports, TS import-equals, dynamic import and require.
    { code: `export * from 'fs';`, errors: [{ messageId: 'builtin', data: { source: 'fs' } }] },
    { code: `export { readFile } from 'node:fs';`, errors: [{ messageId: 'builtin', data: { source: 'node:fs' } }] },
    { code: `import fs = require('fs');`, errors: [{ messageId: 'builtin', data: { source: 'fs' } }] },
    { code: `export const load = () => import('node:os');`, errors: [{ messageId: 'builtin', data: { source: 'node:os' } }] },
    { code: `const path = require('node:path');`, errors: [{ messageId: 'builtin', data: { source: 'node:path' } }] },
    { code: 'const fs = require(`fs`);', errors: [{ messageId: 'builtin', data: { source: 'fs' } }] },
    // Activity and service modules.
    {
      code: `import { charge } from './activities/payments';`,
      errors: [{ messageId: 'activity', data: { source: './activities/payments', pattern: '**/activities/**' } }],
    },
    { code: `import * as acts from '../activities';`, errors: [{ messageId: 'activity' }] },
    { code: `import { charge } from '../../src/activities/index.js';`, errors: [{ messageId: 'activity' }] },
    {
      code: `import { charge } from './payments.activities';`,
      errors: [{ messageId: 'activity', data: { source: './payments.activities', pattern: '**/*.activities' } }],
    },
    {
      code: `import { charge } from './payments.activities.ts';`,
      errors: [{ messageId: 'activity', data: { source: './payments.activities.ts', pattern: '**/*.activities.ts' } }],
    },
    {
      code: `import { charge } from './payments.activities.js';`,
      errors: [{ messageId: 'activity', data: { source: './payments.activities.js', pattern: '**/*.activities.js' } }],
    },
    { code: `import { send } from '../services/mailer';`, errors: [{ messageId: 'activity', data: { source: '../services/mailer', pattern: '**/services/**' } }] },
    { code: `import { Mailer } from './mailer.service';`, errors: [{ messageId: 'activity', data: { source: './mailer.service', pattern: '**/*.service' } }] },
    { code: `import { Mailer } from './mailer.service.ts';`, errors: [{ messageId: 'activity', data: { source: './mailer.service.ts', pattern: '**/*.service.ts' } }] },
    { code: `import { Mailer } from '../lib/mailer.service.js';`, errors: [{ messageId: 'activity', data: { source: '../lib/mailer.service.js', pattern: '**/*.service.js' } }] },
    { code: `import { Mailer } from '@acme/app/services/mailer';`, errors: [{ messageId: 'activity' }] },
    { code: `import { type Refund, charge } from './activities/payments';`, errors: [{ messageId: 'activity' }] },
    { code: `export { charge } from './payments.activities.ts';`, errors: [{ messageId: 'activity' }] },
    { code: `const acts = require('./activities/payments');`, errors: [{ messageId: 'activity' }] },
    { code: `export const load = () => import('./mailer.service.js');`, errors: [{ messageId: 'activity' }] },
    // Custom patterns.
    {
      code: `import { get } from './io/http.ts';`,
      options: [{ activityPatterns: ['**/io/**'] }],
      errors: [{ messageId: 'activity', data: { source: './io/http.ts', pattern: '**/io/**' } }],
    },
    // `onlyAllowed`: bare packages outside the allow list are reported; built-ins keep their own message.
    {
      code: `import _ from 'lodash';`,
      options: [{ onlyAllowed: true }],
      errors: [{ messageId: 'notAllowed', data: { source: 'lodash' } }],
    },
    {
      code: `import { z } from 'zod'; import { Sdk } from '@acme/sdk';`,
      options: [{ onlyAllowed: true, allow: ['zod/v4'] }],
      errors: [
        { messageId: 'notAllowed', data: { source: 'zod' } },
        { messageId: 'notAllowed', data: { source: '@acme/sdk' } },
      ],
    },
    // Packages that cannot run in the workflow sandbox are denied by default, with or without `onlyAllowed`.
    ...[
      '@temporalio/activity',
      '@temporalio/client',
      '@temporalio/worker',
      '@temporalio/testing',
      '@norn-ts/activity',
      '@norn-ts/worker',
      '@norn-ts/client',
      '@norn-ts/testing',
      '@norn-ts/hono',
      '@norn-ts/cli',
    ].map((source) => ({
      code: `import { x } from '${source}';`,
      errors: [{ messageId: 'denied', data: { source } }],
    })),
    { code: `import { x } from '@temporalio/worker/lib/bundler';`, errors: [{ messageId: 'denied' }] },
    { code: `import { x } from '@norn-ts/testing/vite';`, options: [{ onlyAllowed: true }], errors: [{ messageId: 'denied' }] },
    { code: `const { Connection } = require('@temporalio/client');`, errors: [{ messageId: 'denied' }] },
    { code: `export * from '@norn-ts/activity';`, errors: [{ messageId: 'denied' }] },
    // `deny` adds to the defaults (and matches subpaths).
    {
      code: `import axios from 'axios'; import { get } from 'got/dist'; import { Client } from '@temporalio/client';`,
      options: [{ deny: ['axios', 'got'] }],
      errors: [
        { messageId: 'denied', data: { source: 'axios' } },
        { messageId: 'denied', data: { source: 'got/dist' } },
        { messageId: 'denied', data: { source: '@temporalio/client' } },
      ],
    },
    // Inline `type` specifiers alone still load the module under verbatimModuleSyntax (it becomes `import {} from 'm'`).
    {
      code: `import { type Stats } from 'fs';`,
      errors: [{ messageId: 'inlineTypeOnly', data: { source: 'fs', keyword: 'import' } }],
    },
    {
      code: `import { type ChargeResult, type Refund } from './activities/payments';`,
      errors: [{ messageId: 'inlineTypeOnly', data: { source: './activities/payments', keyword: 'import' } }],
    },
    {
      code: `export { type Refund } from './payments.activities.ts';`,
      errors: [{ messageId: 'inlineTypeOnly', data: { source: './payments.activities.ts', keyword: 'export' } }],
    },
    {
      code: `import { type Client } from '@temporalio/client';`,
      errors: [{ messageId: 'inlineTypeOnly', data: { source: '@temporalio/client', keyword: 'import' } }],
    },
    {
      code: `import { type Thing } from 'lodash';`,
      options: [{ onlyAllowed: true }],
      errors: [{ messageId: 'inlineTypeOnly', data: { source: 'lodash', keyword: 'import' } }],
    },
    {
      code: `import { x } from '@temporalio/workflow-extra';`,
      options: [{ onlyAllowed: true }],
      errors: [{ messageId: 'notAllowed' }],
    },
    {
      code: `const _ = require('lodash');`,
      options: [{ onlyAllowed: true }],
      errors: [{ messageId: 'notAllowed' }],
    },
    {
      code: `import fs from 'fs';`,
      options: [{ onlyAllowed: true }],
      errors: [{ messageId: 'builtin' }],
    },
    // Problems in a decorated workflow file.
    {
      code: `
import { readFileSync } from 'node:fs';
import { charge } from './activities/payments.ts';
import { Workflow } from '@norn-ts/workflow';

@Workflow()
export class Orders {
  async run() { return charge(readFileSync('x', 'utf8')); }
}
`,
      errors: [{ messageId: 'builtin', line: 2 }, { messageId: 'activity', line: 3 }],
    },
  ],
});
