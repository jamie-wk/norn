import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineSearchAttributeKey } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import { assertReplays, createTestEnv, loadHistories, mockActivities } from '../src/index.ts';
import { Reminders, Waits } from './fixtures/contracts.ts';
import { NotifyActivities } from './fixtures/refs.ts';
import { registry } from './fixtures/registry.ts';

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${n++}`;

describe('createTestEnv', () => {
  it('runs the registry on a real dev server with mocked activities', async () => {
    const mocks = mockActivities(NotifyActivities, { email: async (to) => `mock-${to}` });
    await using env = await createTestEnv({ registry, activities: mocks });
    const userId = uid('u');
    const result = await env.workflow(Reminders).execute({ userId, email: 'a@b.c', delay: '100ms' });
    expect(result).toEqual({ messageId: 'mock-a@b.c', snoozed: 0 });
    expect(mocks.email.calls).toEqual([['a@b.c', 'reminder after 0 snoozes']]);
  });

  it('skips time with the time-skipping server and uses the real container', async () => {
    await using env = await createTestEnv({ registry, mode: 'time-skipping' });
    const started = Date.now();
    const handle = await env.workflow(Reminders).start({ userId: uid('u'), email: 'x@y.z' });
    await handle.signal('snooze');
    expect(await handle.result()).toEqual({ messageId: 'msg-1', snoozed: 1 });
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('advances time manually with sleep()', async () => {
    await using env = await createTestEnv({ registry, mode: 'time-skipping' });
    const handle = await env.workflow(Reminders).start({ userId: uid('u'), email: 'x@y.z', delay: '2 hours' });
    await env.sleep('1 hour');
    expect(await handle.query('status')).toEqual({ stage: 'waiting', snoozed: 0 });
    await env.sleep('2 hours');
    expect(await handle.result()).toMatchObject({ snoozed: 0 });
  });

  it.each(['local', 'time-skipping'] as const)('registers search attributes in %s mode', async (mode) => {
    await using env = await createTestEnv({ registry, mode, worker: false, searchAttributes: { NornTestTag: 'keyword', NornTestCount: 'int' } });
    const tag = defineSearchAttributeKey('NornTestTag', 'KEYWORD');
    const count = defineSearchAttributeKey('NornTestCount', 'INT');
    const handle = await env.temporal.client.workflow.start('WaitWorkflow', {
      taskQueue: 'testing-q',
      workflowId: uid('sa'),
      typedSearchAttributes: [
        { key: tag, value: 'blue' },
        { key: count, value: 3 },
      ],
    });
    const described = await handle.describe();
    expect(described.typedSearchAttributes.get(tag)).toBe('blue');
    expect(described.typedSearchAttributes.get(count)).toBe(3);
    await handle.terminate('cleanup');
  });

  it('can start without a worker', async () => {
    await using env = await createTestEnv({ registry, worker: false });
    expect(env.worker).toBeUndefined();
    const handle = await env.workflow(Waits).start(undefined, { workflowId: uid('w') });
    expect((await handle.describe()).status).toBe('RUNNING');
    await handle.terminate('cleanup');
  });

  it('rejects mocks for unknown activities', async () => {
    await expect(createTestEnv({ registry, activities: { 'notify.nope': async () => 1 } })).rejects.toThrow(/unknown activity notify\.nope/);
  });
});

describe('replay', () => {
  it('replays recorded histories and catches incompatible changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'norn-histories-'));
    try {
      {
        await using env = await createTestEnv({ registry });
        for (const userId of [uid('a'), uid('b')]) {
          const handle = await env.workflow(Reminders).start({ userId, email: 'r@e.p', delay: '50ms' });
          await handle.result();
          const history = await handle.temporal.fetchHistory();
          await writeFile(join(dir, `${handle.workflowId}.json`), historyToJSON(history));
        }
      }
      const histories = await loadHistories(dir);
      expect(histories).toHaveLength(2);
      expect(histories[0]!.workflowId).toMatch(/^reminder-/);

      await expect(assertReplays(histories, { registry })).resolves.toEqual({ replayed: 2 });

      const changed = fileURLToPath(new URL('./fixtures/workflows-changed.ts', import.meta.url));
      const failure = await assertReplays(histories, { workflowsPath: changed }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/2 of 2 histories failed to replay/);
      expect((failure as Error).message).toContain(histories[0]!.workflowId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects empty history sets and bad files', async () => {
    await expect(assertReplays([], { registry })).rejects.toThrow(/No histories/);
    const dir = await mkdtemp(join(tmpdir(), 'norn-histories-'));
    try {
      await writeFile(join(dir, 'broken.json'), '{nope');
      await expect(loadHistories(dir)).rejects.toThrow(/broken\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
