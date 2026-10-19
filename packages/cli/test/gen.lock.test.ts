import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../src/index.ts';
import { copyFixture, expectError, removeDir } from './helpers.ts';

let dir: string;
afterEach(() => removeDir(dir));

const lockOf = () => JSON.parse(readFileSync(join(dir, 'norn.lock.json'), 'utf8'));

describe('norn.lock.json', () => {
  it('fails when locked names disappear, explaining that in-flight executions break', async () => {
    dir = copyFixture('errors/lock-rename');
    const original = readFileSync(join(dir, 'norn.lock.json'), 'utf8');
    const { errors, written } = await generate({ cwd: dir });
    expect(written).toEqual([]);
    const legacy = expectError(errors, { code: 'lock-removed', file: 'norn.lock.json', message: 'workflow type "LegacyWorkflow"' });
    expect(legacy.message).toContain('in-flight');
    expect(legacy.hint).toContain('--accept-rename');
    expectError(errors, { code: 'lock-removed', message: 'signal "pause" of OrderWorkflow' });
    expectError(errors, { code: 'lock-removed', message: 'query "status" of OrderWorkflow' });
    expectError(errors, { code: 'lock-removed', message: 'update "add-item" of OrderWorkflow' });
    expectError(errors, { code: 'lock-removed', message: 'activity "pay.refund"' });
    expect(errors).toHaveLength(5);
    expect(readFileSync(join(dir, 'norn.lock.json'), 'utf8')).toBe(original);
  });

  it('reports the same errors in --check mode', async () => {
    dir = copyFixture('errors/lock-rename');
    const { errors } = await generate({ cwd: dir, check: true });
    expect(errors.map((e) => e.code)).toEqual(Array(5).fill('lock-removed'));
  });

  it('updates the lock with --accept-rename', async () => {
    dir = copyFixture('errors/lock-rename');
    const { errors, written } = await generate({ cwd: dir, acceptRename: true });
    expect(errors).toEqual([]);
    expect(written).toContain('norn.lock.json');
    expect(lockOf()).toEqual({
      version: 1,
      workflows: { OrderWorkflow: { taskQueue: 'orders', signals: ['cancel', 'expedite'], queries: ['state'], updates: [] } },
      activities: ['pay.charge'],
    });
  });

  it('adds new names without complaint', async () => {
    dir = copyFixture('errors/lock-rename');
    await generate({ cwd: dir, acceptRename: true });
    const file = join(dir, 'src/activities.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('@Activity() async charge() {}', '@Activity() async charge() {}\n  @Activity() async refund() {}'));
    const { errors, written } = await generate({ cwd: dir });
    expect(errors).toEqual([]);
    expect(written).toContain('norn.lock.json');
    expect(lockOf().activities).toEqual(['pay.charge', 'pay.refund']);
  });

  it('treats a task queue change as breaking', async () => {
    dir = copyFixture('errors/lock-rename');
    await generate({ cwd: dir, acceptRename: true });
    const file = join(dir, 'src/order.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("taskQueue: 'orders'", "taskQueue: 'orders-v2'"));
    const { errors } = await generate({ cwd: dir });
    expectError(errors, { code: 'lock-removed', message: 'task queue of OrderWorkflow changed from "orders" to "orders-v2"' });
    expect(errors).toHaveLength(1);
  });

  it('rejects a lock file it cannot read', async () => {
    dir = copyFixture('errors/lock-rename');
    writeFileSync(join(dir, 'norn.lock.json'), '{ not json');
    const { errors } = await generate({ cwd: dir });
    expectError(errors, { code: 'lock-invalid', file: 'norn.lock.json' });
    expect(errors).toHaveLength(1);
  });
});
