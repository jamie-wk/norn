import { describe, expect, it } from 'vitest';
import { formatError, generate, type NornGenError } from '../src/index.ts';
import { at, expectError, fixture } from './helpers.ts';

async function errorsOf(name: string): Promise<NornGenError[]> {
  const result = await generate({ cwd: fixture(`errors/${name}`), write: false });
  expect(result.written).toEqual([]);
  expect(result.files).toEqual({});
  return result.errors;
}

describe('decorator options must be literals', () => {
  it('reports every non-literal value with its location and a hint', async () => {
    const errors = await errorsOf('bad-literal');
    const f = 'errors/bad-literal';
    const wf = 'src/workflows.ts';
    const acts = 'src/activities.ts';
    const queue = expectError(errors, { code: 'non-literal', ...at(f, wf, 'QUEUE }'), message: '@Workflow option "taskQueue"' });
    expect(queue.message).toContain('identifier QUEUE');
    expect(queue.hint).toMatch(/norn gen reads decorators without running your code/);
    expectError(errors, { code: 'non-literal', ...at(f, wf, '`cancel-'), message: 'template literal with expressions' });
    expectError(errors, { code: 'non-literal', ...at(f, acts, 'TIMEOUT }'), message: '@Activity option "timeout"' });
    expectError(errors, { code: 'non-literal', ...at(f, acts, '1 + 2'), message: '@Activity option "retries"' });
    expectError(errors, { code: 'non-literal', ...at(f, acts, '...defaults'), message: 'spread' });
    expectError(errors, { code: 'non-literal', ...at(f, acts, 'getName()'), message: 'call expression' });
    expect(errors).toHaveLength(6);
  });

  it('formats errors as file:line:col with the hint', async () => {
    const [first] = await errorsOf('bad-literal');
    const text = formatError(first!);
    expect(text).toMatch(/^src\/activities\.ts:8:24 - error norn\(non-literal\): /);
    expect(text).toContain('\n  hint: ');
  });
});

describe('dependency inference', () => {
  it('requires a type annotation on every constructor parameter', async () => {
    const errors = await errorsOf('missing-annotation');
    const e = expectError(errors, { code: 'missing-annotation', ...at('errors/missing-annotation', 'src/services.ts', '_db,') });
    expect(e.message).toContain('Scheduler');
    expect(e.message).toContain('"_db"');
    expect(e.hint).toContain('inject: [');
    expect(errors).toHaveLength(1);
  });

  it('rejects interfaces without a same-named token', async () => {
    const errors = await errorsOf('interface-without-token');
    const f = 'errors/interface-without-token';
    const clock = expectError(errors, { code: 'interface-without-token', ...at(f, 'src/services.ts', 'Clock,') });
    expect(clock.message).toContain('Clock is only a type');
    expect(clock.hint).toContain("export const Clock = token<Clock>('Clock')");
    const mailer = expectError(errors, { code: 'interface-without-token', ...at(f, 'src/services.ts', 'Mailer,') });
    expect(mailer.message).toContain('src/mailer.ts');
    expect(errors).toHaveLength(2);
  });

  it('rejects primitive, union, generic, rest and unresolvable parameter types', async () => {
    const errors = await errorsOf('bad-dependency-types');
    const f = 'errors/bad-dependency-types';
    const file = 'src/services.ts';
    expectError(errors, { code: 'unsupported-type', ...at(f, file, 'string,'), message: 'primitive' });
    expectError(errors, { code: 'unsupported-type', ...at(f, file, 'Date | number'), message: 'union' });
    expectError(errors, { code: 'unsupported-type', ...at(f, file, 'Repo<string>'), message: 'generic' });
    expectError(errors, { code: 'unsupported-type', ...at(f, file, '..._rest'), message: 'rest parameter' });
    expectError(errors, { code: 'unresolved-type', ...at(f, file, 'Missing,'), message: './missing.js' });
    expectError(errors, { code: 'unresolved-type', ...at(f, file, 'Unknown,'), message: 'not imported or declared' });
    expectError(errors, { code: 'interface-without-token', ...at(f, file, 'NotExported,'), message: 'src/other.ts' });
    expect(errors).toHaveLength(7);
    for (const e of errors) expect(e.hint).toContain('inject: [');
  });
});

describe('duplicate names', () => {
  it('reports duplicate workflow types, handlers, activities and activity class names', async () => {
    const errors = await errorsOf('duplicate-names');
    const f = 'errors/duplicate-names';
    expectError(errors, { code: 'duplicate-handler', ...at(f, 'src/workflows.ts', "@Signal('cancel')"), message: 'signal "cancel"' });
    expectError(errors, { code: 'duplicate-handler', ...at(f, 'src/workflows.ts', "@Query({ name: 'status' })"), message: 'query "status"' });
    const wf = expectError(errors, { code: 'duplicate-workflow', ...at(f, 'src/workflows.ts', "@Workflow({ taskQueue: 'b'") });
    expect(wf.message).toContain('"OrderWorkflow"');
    expect(wf.message).toContain('src/workflows.ts:3');
    expectError(errors, { code: 'duplicate-activity', ...at(f, 'src/activities.ts', "@Activity({ name: 'charge' })"), message: '"pay.charge"' });
    const across = expectError(errors, { code: 'duplicate-activity', ...at(f, 'src/activities.ts', '@Activity()', 2) });
    expect(across.message).toContain('PayActivities');
    expectError(errors, { code: 'duplicate-class', ...at(f, 'src/more.ts', 'PayActivities'), message: 'src/activities.ts' });
    expect(errors).toHaveLength(6);
  });
});

describe('import boundaries', () => {
  it('rejects value imports of activity files but allows import type', async () => {
    const errors = await errorsOf('workflow-imports-activity');
    const e = expectError(errors, { code: 'import-boundary', file: 'src/workflows/order.ts', line: 2, column: 1 });
    expect(e.message).toContain('src/activities/payment.ts');
    expect(e.message).toContain('@Activities');
    expect(e.hint).toContain('import type');
    expect(errors).toHaveLength(1);
  });

  it('rejects Node built-ins and worker-only packages, including re-exports and dynamic imports', async () => {
    const errors = await errorsOf('workflow-imports-builtin');
    const file = 'src/order.ts';
    expectError(errors, { code: 'import-boundary', file, line: 1, message: 'Node built-in "node:fs"' });
    expectError(errors, { code: 'import-boundary', file, line: 2, message: 'Node built-in "path"' });
    expectError(errors, { code: 'import-boundary', file, line: 3, message: '"@temporalio/client"' });
    expectError(errors, { code: 'import-boundary', file, line: 4, message: '"@norn/activity"' });
    expectError(errors, { code: 'import-boundary', file, line: 5, message: '"@norn/worker/sub/path"' });
    expectError(errors, { code: 'import-boundary', file, line: 8, message: '"@temporalio/activity"' });
    expectError(errors, { code: 'import-boundary', file, line: 14, message: 'Node built-in "node:crypto"' });
    expect(errors).toHaveLength(7);
  });

  it('treats imports with only inline type specifiers as value imports', async () => {
    const errors = await errorsOf('inline-type-import');
    const file = 'src/workflows/order.ts';
    const local = expectError(errors, { code: 'import-boundary', file, line: 2 });
    expect(local.hint).toMatch(/import type \{ PaymentActivities \}/);
    expect(local.message).toContain('verbatimModuleSyntax');
    expectError(errors, { code: 'import-boundary', file, line: 3, message: '"@temporalio/activity"' });
    expect(errors).toHaveLength(2);
  });

  it('follows relative imports transitively and reports each violation once', async () => {
    const errors = await errorsOf('transitive-import');
    const money = expectError(errors, { code: 'import-boundary', file: 'src/lib/money.ts', line: 1, column: 1 });
    expect(money.message).toContain('src/activities/payment.ts');
    expect(money.message).toContain('src/workflows/order.ts → src/lib/index.ts → src/lib/money.ts');
    const env = expectError(errors, { code: 'import-boundary', file: 'src/lib/env.ts', line: 1, message: 'node:os' });
    expect(env.message).toContain('src/workflows/order.ts → src/lib/index.ts → src/lib/env.ts');
    expect(errors).toHaveLength(2);
  });
});

describe('determinism', () => {
  it('flags sandbox-unsafe globals in workflow code only, respecting local bindings', async () => {
    const errors = await errorsOf('determinism');
    const f = 'errors/determinism';
    const file = 'src/order.ts';
    const timer = expectError(errors, { code: 'determinism', ...at(f, file, 'setTimeout(() => {}, 10)') });
    expect(timer.hint).toContain('sleep(');
    expectError(errors, { code: 'determinism', ...at(f, file, 'setInterval'), message: 'setInterval' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'setImmediate'), message: 'setImmediate' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'process.env.REGION'), message: 'process' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'Temporal.Now'), message: 'Temporal.Now' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'crypto.randomUUID'), message: 'crypto' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'performance.now'), message: 'performance' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'WeakRef('), message: 'WeakRef' });
    expectError(errors, { code: 'determinism', ...at(f, file, 'FinalizationRegistry('), message: 'FinalizationRegistry' });
    expect(errors).toHaveLength(9);
  });
});

describe('workflow structure', () => {
  it('checks @Validate targets', async () => {
    const errors = await errorsOf('validate-non-update');
    const f = 'errors/validate-non-update';
    expectError(errors, { code: 'invalid-validate', ...at(f, 'src/order.ts', "@Validate('cancel')"), message: 'cancel() is a @Signal' });
    expectError(errors, { code: 'invalid-validate', ...at(f, 'src/order.ts', "@Validate('missing')"), message: 'no @Update method missing()' });
    expectError(errors, { code: 'invalid-validate', ...at(f, 'src/order.ts', "@Validate('add')", 2), message: 'more than one validator' });
    expect(errors).toHaveLength(3);
  });

  it('rejects conflicting search attribute types across workflows', async () => {
    const errors = await errorsOf('conflicting-search-attributes');
    const e = expectError(errors, { code: 'search-attribute-conflict', ...at('errors/conflicting-search-attributes', 'src/refund.ts', "CustomerId: 'text'") });
    expect(e.message).toContain('"keyword"');
    expect(e.message).toContain('src/order.ts:3');
    expect(errors).toHaveLength(1);
  });

  it('checks classes, members and option values', async () => {
    const errors = await errorsOf('workflow-structure');
    const f = 'errors/workflow-structure';
    const file = 'src/workflows.ts';
    expectError(errors, { code: 'missing-run', ...at(f, file, 'NoRunWorkflow'), message: 'run()' });
    expectError(errors, { code: 'invalid-member', ...at(f, file, '@Signal() #secret'), message: 'private' });
    expectError(errors, { code: 'invalid-member', ...at(f, file, '@Query() static'), message: 'static' });
    expectError(errors, { code: 'invalid-decorator', ...at(f, file, '@Signal ping'), message: '@Signal()' });
    expectError(errors, { code: 'not-exported', ...at(f, file, 'HiddenWorkflow {'), message: 'named export' });
    expectError(errors, { code: 'invalid-decorator', ...at(f, file, "@Schedule('0 * * * *')"), message: '@Workflow' });
    expectError(errors, { code: 'invalid-option', ...at(f, file, "'every day'"), message: 'cron' });
    expectError(errors, { code: 'invalid-option', ...at(f, file, "overlap: 'sometimes'"), message: 'overlap' });
    expectError(errors, { code: 'invalid-option', ...at(f, file, "taskQueue: ''"), message: 'taskQueue' });
    expectError(errors, { code: 'invalid-option', ...at(f, file, "name: 'bad-name'"), message: 'identifier' });
    expectError(errors, { code: 'invalid-option', ...at(f, file, "Size: 'number'"), message: 'keyword' });
    expectError(errors, { code: 'invalid-option', ...at(f, file, "versioning: 'sometimes'"), message: 'pinned' });
    expectError(errors, { code: 'invalid-option', ...at(f, 'src/classes.ts', 'prefix: 1'), message: 'prefix' });
    expectError(errors, { code: 'invalid-decorator', ...at(f, 'src/classes.ts', 'EmptyActivities'), message: 'no @Activity methods' });
    expectError(errors, { code: 'invalid-decorator', ...at(f, 'src/classes.ts', 'ConfusedClass'), message: 'both @Workflow and @Activities' });
    expectError(errors, { code: 'invalid-option', ...at(f, 'src/classes.ts', "scope: 'request'"), message: 'scope' });
    expectError(errors, { code: 'duplicate-schedule', ...at(f, file, "@Schedule('0 1 * * *')"), message: '"twice-scheduled-workflow"' });
    expect(errors).toHaveLength(17);
  });

  it('reports syntax errors with their location', async () => {
    const { project, removeDir } = await import('./helpers.ts');
    const dir = project({ 'src/broken.ts': "import { Workflow } from '@norn/workflow';\n\nconst x = ;\n" });
    try {
      const { errors } = await generate({ cwd: dir, write: false });
      expectError(errors, { code: 'parse-error', file: 'src/broken.ts', line: 3 });
      expect(errors).toHaveLength(1);
    } finally {
      removeDir(dir);
    }
  });
});
