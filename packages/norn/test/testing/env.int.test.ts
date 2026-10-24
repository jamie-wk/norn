import { describe, expect, it, vi } from 'vitest';
import { defineSearchAttributeKey, type Payload } from '@temporalio/common';
import { createTestEnv } from '../../src/testing/index.ts';
import { NotifyActivities } from './fixtures/activities.ts';
import { ReminderWorkflow, WaitWorkflow } from './fixtures/workflow-classes.ts';

const workflows = new URL('./fixtures/workflows.ts', import.meta.url);

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${n++}`;

describe('createTestEnv', () => {
  it('runs the workflows on a real dev server with fake activities', async () => {
    const email = vi.fn(async (to: string) => `fake-${to}`);
    await using env = await createTestEnv({ workflows, activities: { notify: { email, audit: async () => 'ok' } } });
    const result = await env.workflow(ReminderWorkflow).execute({ userId: uid('u'), email: 'a@b.c', delay: '100ms' });
    expect(result).toEqual({ messageId: 'fake-a@b.c', snoozed: 0 });
    expect(email).toHaveBeenCalledWith('a@b.c', 'reminder after 0 snoozes');
  });

  it('skips time with the time-skipping server, with real activity instances', async () => {
    const notify = new NotifyActivities();
    await using env = await createTestEnv({ workflows, activities: { notify }, mode: 'time-skipping' });
    const started = Date.now();
    const handle = await env.workflow(ReminderWorkflow).start({ userId: uid('u'), email: 'x@y.z' });
    await handle.signal('snooze');
    expect(await handle.result()).toEqual({ messageId: 'msg-1', snoozed: 1 });
    expect(notify.sent).toEqual(['x@y.z:reminder after 1 snoozes']);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('advances time manually with sleep()', async () => {
    await using env = await createTestEnv({ workflows, activities: { notify: new NotifyActivities() }, mode: 'time-skipping' });
    const handle = await env.workflow(ReminderWorkflow).start({ userId: uid('u'), email: 'x@y.z', delay: '2 hours' });
    await env.sleep('1 hour');
    expect(await handle.query('status')).toEqual({ stage: 'waiting', snoozed: 0 });
    await env.sleep('2 hours');
    expect(await handle.result()).toMatchObject({ snoozed: 0 });
  });

  it.each(['local', 'time-skipping'] as const)('registers search attributes in %s mode', async (mode) => {
    await using env = await createTestEnv({ workflows, mode, worker: false, searchAttributes: { NornTestTag: 'keyword', NornTestCount: 'int' } });
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
    await using env = await createTestEnv({ workflows, worker: false });
    expect(env.worker).toBeUndefined();
    const handle = await env.workflow(WaitWorkflow).start(undefined, { workflowId: uid('w') });
    expect((await handle.describe()).status).toBe('RUNNING');
    await handle.terminate('cleanup');
  });

  it('uses clientDataConverter in time-skipping mode', async () => {
    const encoded: Payload[] = [];
    const payloadCodecs = [{ encode: async (p: Payload[]) => (encoded.push(...p), p), decode: async (p: Payload[]) => p }];
    await using env = await createTestEnv({ workflows, mode: 'time-skipping', worker: false, clientDataConverter: { payloadCodecs } });
    const handle = await env.workflow(ReminderWorkflow).start({ userId: uid('codec'), email: 'x@y.z' });
    expect(encoded.length).toBeGreaterThan(0);
    await handle.terminate('cleanup');
  });
});
