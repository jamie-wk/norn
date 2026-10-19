import plugin from '../src/index.ts';
import { ruleTester } from './rule-tester.ts';

const rule = plugin.rules['workflow-determinism'];
const strict = [{ strict: true }];

/** A Norn workflow class, so every case also proves the parser handles TC39 decorators. */
const inWorkflow = (body: string) => `
import { condition, sleep, workflowInfo, uuid4 } from '@temporalio/workflow';
import { Signal, Workflow } from '@norn/workflow';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  private done = false;
  @Signal() finish() { this.done = true; }
  async run(input: { orderId: string }) {
    ${body}
  }
}
`;

ruleTester.run('workflow-determinism', rule, {
  valid: [
    // Temporal workflow APIs are the recommended replacements.
    inWorkflow('await sleep(1000); await condition(() => this.done, "1 day"); return uuid4();'),
    inWorkflow('return workflowInfo().startTime;'),
    // Date and Math.random are made deterministic by the workflow sandbox, so they are allowed by default.
    inWorkflow('const now = Date.now(); const d = new Date(); return Math.random() + now + d.getTime();'),
    inWorkflow('return Date();'),
    // Date with an argument is always deterministic, even in strict mode.
    { code: inWorkflow('return new Date(input.orderId);'), options: strict },
    { code: inWorkflow('return new Date(2026, 0, 1).toISOString();'), options: strict },
    { code: inWorkflow('return Date.parse("2026-01-01") + Date.UTC(2026, 0);'), options: strict },
    { code: inWorkflow('return Math.max(1, 2) + Math.floor(1.5);'), options: strict },
    // Temporal (TC39) APIs other than Temporal.Now are pure.
    inWorkflow('return Temporal.Instant.fromEpochMilliseconds(Date.now());'),
    inWorkflow('return Temporal.Duration.from({ hours: 1 });'),
    // Locally declared bindings shadow the globals.
    inWorkflow('const process = { env: {} }; return process.env;'),
    inWorkflow('const setTimeout = (fn: () => void) => fn(); setTimeout(() => {});'),
    inWorkflow('const crypto = { randomUUID: () => "x" }; return crypto.randomUUID();'),
    inWorkflow('const performance = { now: () => 1 }; return performance.now();'),
    `function run(Temporal: { Now: { instant(): number } }) { return Temporal.Now.instant(); }`,
    // Type positions never run.
    `type Env = typeof process.env; let t: Temporal.Instant; export type { Env, t };`,
    `import type { Temporal as T } from '@js-temporal/polyfill'; let x: T.Instant; export { x };`,
    // Property names that merely look like globals.
    inWorkflow('const o = { process: 1, setTimeout: 2 }; return o.process + o.setTimeout;'),
    inWorkflow('return this.process?.env;'),
  ],
  invalid: [
    {
      code: inWorkflow('setTimeout(() => {}, 1000);'),
      errors: [{ messageId: 'setTimeout' }],
    },
    {
      code: inWorkflow('const t = setTimeout; clearTimeout(t(() => {}, 5));'),
      errors: [{ messageId: 'setTimeout' }],
    },
    {
      code: inWorkflow('setInterval(() => {}, 1000);'),
      errors: [{ messageId: 'unavailableTimer', data: { name: 'setInterval' } }],
    },
    {
      code: inWorkflow('await new Promise((r) => setImmediate(r));'),
      errors: [{ messageId: 'unavailableTimer', data: { name: 'setImmediate' } }],
    },
    {
      code: inWorkflow('globalThis.setTimeout(() => {}, 1);'),
      errors: [{ messageId: 'setTimeout' }],
    },
    {
      code: inWorkflow('return process.env.API_KEY;'),
      errors: [{ messageId: 'process', data: { expr: 'process.env' } }],
    },
    {
      code: inWorkflow('const [s] = process.hrtime(); return s;'),
      errors: [{ messageId: 'process', data: { expr: 'process.hrtime' } }],
    },
    {
      code: inWorkflow('return process["argv"];'),
      errors: [{ messageId: 'process', data: { expr: 'process["argv"]' } }],
    },
    {
      code: inWorkflow('const p = process; return p;'),
      errors: [{ messageId: 'process', data: { expr: 'process' } }],
    },
    {
      code: inWorkflow('return globalThis.process.env.X;'),
      errors: [{ messageId: 'process', data: { expr: 'globalThis.process.env' } }],
    },
    {
      code: inWorkflow('return process?.env;'),
      errors: [{ messageId: 'process', data: { expr: 'process?.env' } }],
    },
    {
      code: inWorkflow('return Temporal.Now.instant();'),
      errors: [{ messageId: 'temporalNow', data: { expr: 'Temporal.Now.instant' } }],
    },
    {
      code: inWorkflow('return Temporal.Now.plainDateISO().toString() + Temporal.Now.zonedDateTimeISO("UTC");'),
      errors: [
        { messageId: 'temporalNow', data: { expr: 'Temporal.Now.plainDateISO' } },
        { messageId: 'temporalNow', data: { expr: 'Temporal.Now.zonedDateTimeISO' } },
      ],
    },
    {
      code: inWorkflow('const { Now } = Temporal; const clock = Temporal.Now; return [Now, clock];'),
      errors: [{ messageId: 'temporalNow', data: { expr: 'Temporal' } }, { messageId: 'temporalNow', data: { expr: 'Temporal.Now' } }],
    },
    {
      code: `import { Temporal } from '@js-temporal/polyfill';\nexport const now = () => Temporal.Now.instant();`,
      errors: [{ messageId: 'temporalNow', data: { expr: 'Temporal.Now.instant' } }],
    },
    {
      code: `import { Temporal } from 'temporal-polyfill';\nexport const now = () => Temporal.Now.instant();`,
      errors: [{ messageId: 'temporalNow', data: { expr: 'Temporal.Now.instant' } }],
    },
    {
      code: inWorkflow('return crypto.randomUUID();'),
      errors: [{ messageId: 'crypto', data: { expr: 'crypto.randomUUID' } }],
    },
    {
      code: inWorkflow('return crypto.getRandomValues(new Uint8Array(4));'),
      errors: [{ messageId: 'crypto', data: { expr: 'crypto.getRandomValues' } }],
    },
    {
      code: inWorkflow('return globalThis.crypto.randomUUID();'),
      errors: [{ messageId: 'crypto', data: { expr: 'globalThis.crypto.randomUUID' } }],
    },
    {
      code: inWorkflow('return performance.now();'),
      errors: [{ messageId: 'performance', data: { expr: 'performance.now' } }],
    },
    {
      code: inWorkflow('const ref = new WeakRef(this); return ref;'),
      errors: [{ messageId: 'gc', data: { name: 'WeakRef' } }],
    },
    {
      code: inWorkflow('return new FinalizationRegistry(() => {});'),
      errors: [{ messageId: 'gc', data: { name: 'FinalizationRegistry' } }],
    },
    // Globals declared in the ESLint config (e.g. from the `globals` package) are still caught.
    {
      code: inWorkflow('setTimeout(() => {}, 1); return process.env.X;'),
      languageOptions: { globals: { setTimeout: 'readonly', process: 'readonly' } },
      errors: [{ messageId: 'setTimeout' }, { messageId: 'process' }],
    },
    // Opt-in strict mode also rejects the sandbox-patched Date and Math.random.
    {
      code: inWorkflow('return Date.now();'),
      options: strict,
      errors: [{ messageId: 'strictDateNow' }],
    },
    {
      code: inWorkflow('const d = new Date(); return d;'),
      options: strict,
      errors: [{ messageId: 'strictNewDate', data: { expr: 'new Date()' } }],
    },
    {
      code: inWorkflow('return Date();'),
      options: strict,
      errors: [{ messageId: 'strictNewDate', data: { expr: 'Date()' } }],
    },
    {
      code: inWorkflow('return Math.random();'),
      options: strict,
      errors: [{ messageId: 'strictMathRandom' }],
    },
    {
      code: inWorkflow('const random = Math.random; return random() + globalThis.Date.now();'),
      options: strict,
      errors: [{ messageId: 'strictMathRandom' }, { messageId: 'strictDateNow' }],
    },
    // Strict mode keeps the default checks.
    {
      code: inWorkflow('setTimeout(() => {}, 1); return Date.now();'),
      options: strict,
      errors: [{ messageId: 'setTimeout' }, { messageId: 'strictDateNow' }],
    },
    // Several problems in one decorated class body, including inside handlers and field initialisers.
    {
      code: `
import { Query, Workflow } from '@norn/workflow';

@Workflow()
export class Clock {
  private readonly startedAt = performance.now();
  @Query() env() { return process.env.NODE_ENV; }
  async run() { setInterval(() => {}, 10); }
}
`,
      errors: [{ messageId: 'performance' }, { messageId: 'process' }, { messageId: 'unavailableTimer' }],
    },
  ],
});
