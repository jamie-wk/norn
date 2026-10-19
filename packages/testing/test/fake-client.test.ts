import { describe, expect, it } from 'vitest';
import {
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowClosedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  defineWorkflow,
  query,
  signal,
  type,
  update,
} from '@norn-ts/core';
import { createFakeClient } from '../src/index.ts';

const Orders = defineWorkflow({
  name: 'OrderWorkflow',
  taskQueue: 'orders',
  id: 'order-{orderId}',
  input: type<{ orderId: string; cents: number }>(),
  output: type<{ status: string }>(),
  signals: { cancel: signal<[reason: string]>() },
  queries: { getStatus: query<{ status: string }>() },
  updates: { addItem: update<number, [sku: string]>() },
});

describe('createFakeClient', () => {
  it('records starts and builds IDs from the contract', async () => {
    const fake = createFakeClient();
    const handle = await fake.workflow(Orders).start({ orderId: 'o1', cents: 5 }, { searchAttributes: {} });
    expect(handle.workflowId).toBe('order-o1');
    expect(fake.calls).toEqual([
      { op: 'start', workflow: 'OrderWorkflow', workflowId: 'order-o1', input: { orderId: 'o1', cents: 5 }, options: { searchAttributes: {} } },
    ]);
    expect(fake.started(Orders)).toEqual([{ orderId: 'o1', cents: 5 }]);
  });

  it('rejects duplicate starts unless ifRunning allows them', async () => {
    const fake = createFakeClient();
    const first = await fake.workflow(Orders).start({ orderId: 'o1', cents: 5 });
    await expect(fake.workflow(Orders).start({ orderId: 'o1', cents: 5 })).rejects.toBeInstanceOf(WorkflowAlreadyStartedError);
    const same = await fake.workflow(Orders).start({ orderId: 'o1', cents: 5 }, { ifRunning: 'useExisting' });
    expect(same.runId).toBe(first.runId);
    const replaced = await fake.workflow(Orders).start({ orderId: 'o1', cents: 5 }, { ifRunning: 'terminateExisting' });
    expect(replaced.runId).not.toBe(first.runId);
    // Only new executions count: not the rejected duplicate or the reused run.
    expect(fake.started(Orders)).toHaveLength(2);
  });

  it('answers handlers from stubs and records every call', async () => {
    const fake = createFakeClient();
    const items: string[] = [];
    fake.stub(Orders, {
      queries: { getStatus: () => ({ status: `items:${items.length}` }) },
      updates: {
        addItem: (sku) => {
          if (!sku) throw new UpdateRejectedError({ workflowId: 'order-o1', update: 'addItem', failureType: 'InvalidItemError', message: 'sku is required' });
          return items.push(sku);
        },
      },
      signals: { cancel: (reason) => void items.push(`cancel:${reason}`) },
    });
    const handle = await fake.workflow(Orders).start({ orderId: 'o1', cents: 5 });
    expect(await handle.update('addItem', 'a')).toBe(1);
    await expect(handle.update('addItem', '')).rejects.toBeInstanceOf(UpdateRejectedError);
    await handle.signal('cancel', 'why');
    expect(await handle.query('getStatus')).toEqual({ status: 'items:2' });
    expect(fake.calls.map((c) => c.op)).toEqual(['start', 'update', 'update', 'signal', 'query']);
    expect(fake.calls[3]).toMatchObject({ op: 'signal', name: 'cancel', args: ['why'], workflowId: 'order-o1' });
  });

  it('throws when a handler has no stub', async () => {
    const fake = createFakeClient();
    const handle = await fake.workflow(Orders).start({ orderId: 'o1', cents: 5 });
    await expect(handle.query('getStatus')).rejects.toThrow(/No fake query getStatus for OrderWorkflow/);
    // Signals without stubs are recorded and accepted.
    await handle.signal('cancel', 'x');
  });

  it('reports unknown workflows as not found', async () => {
    const fake = createFakeClient();
    const ghost = fake.workflow(Orders).get({ orderId: 'nope' });
    await expect(ghost.signal('cancel', 'x')).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.query('getStatus')).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.describe()).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.result()).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('completes and fails workflows on demand', async () => {
    const fake = createFakeClient();
    const done = await fake.workflow(Orders).start({ orderId: 'done', cents: 1 });
    const pending = done.result();
    fake.complete('order-done', { status: 'paid' });
    expect(await pending).toEqual({ status: 'paid' });
    expect((await done.describe()).status).toBe('COMPLETED');
    await expect(done.signal('cancel', 'late')).rejects.toBeInstanceOf(WorkflowClosedError);
    await expect(done.update('addItem', 'late')).rejects.toMatchObject({ status: 409, closeStatus: 'COMPLETED' });

    const failed = await fake.workflow(Orders).start({ orderId: 'bad', cents: 1 });
    fake.fail('order-bad', 'PaymentDeclined', 'declined');
    await expect(failed.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    await expect(failed.result()).rejects.toMatchObject({ failureType: 'PaymentDeclined' });
    expect(() => fake.complete('order-unknown', {})).toThrow(/order-unknown/);
  });

  it('supports signal- and update-with-start', async () => {
    const fake = createFakeClient();
    fake.stub(Orders, { updates: { addItem: () => 7 } });
    const h = await fake.workflow(Orders).signalWithStart({ orderId: 's', cents: 1 }, { signal: 'cancel', args: ['x'] });
    const again = await fake.workflow(Orders).signalWithStart({ orderId: 's', cents: 1 }, { signal: 'cancel', args: ['y'] });
    expect(again.runId).toBe(h.runId);
    const { result, handle } = await fake.workflow(Orders).updateWithStart({ orderId: 'u', cents: 1 }, { update: 'addItem', args: ['a'] });
    expect(result).toBe(7);
    expect(handle.workflowId).toBe('order-u');
    expect(fake.calls.map((c) => c.op)).toEqual(['signalWithStart', 'signalWithStart', 'updateWithStart']);
    expect(fake.started(Orders).map((i) => i.orderId)).toEqual(['s', 'u']);
  });

  it('honours ifRunning: fail on update-with-start', async () => {
    const fake = createFakeClient();
    fake.stub(Orders, { updates: { addItem: () => 7 } });
    await fake.workflow(Orders).start({ orderId: 'u', cents: 1 });
    await expect(
      fake.workflow(Orders).updateWithStart({ orderId: 'u', cents: 1 }, { update: 'addItem', args: ['a'] }, { ifRunning: 'fail' }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyStartedError);
  });

  it('lets tests make Temporal unavailable', async () => {
    const fake = createFakeClient();
    fake.failNext(new Error('boom'));
    await expect(fake.workflow(Orders).start({ orderId: 'x', cents: 1 })).rejects.toThrow('boom');
    expect(fake.started(Orders)).toEqual([]);
    expect(await fake.workflow(Orders).start({ orderId: 'x', cents: 1 })).toBeDefined();
  });

  it('cancels, terminates, lists and resets', async () => {
    const fake = createFakeClient();
    const a = await fake.workflow(Orders).start({ orderId: 'a', cents: 1 });
    await fake.workflow(Orders).start({ orderId: 'b', cents: 1 });
    await a.cancel();
    expect((await a.describe()).status).toBe('CANCELLED');
    await expect(a.result()).rejects.toMatchObject({ failureType: 'Cancelled' });
    const ids: string[] = [];
    for await (const s of fake.workflow(Orders).list()) ids.push(s.workflowId);
    expect(ids).toEqual(['order-a', 'order-b']);
    expect(await fake.workflow(Orders).count()).toBe(2);
    fake.reset();
    expect(fake.calls).toEqual([]);
    expect(fake.started(Orders)).toEqual([]);
    expect(await fake.workflow(Orders).count()).toBe(0);
  });

  it('explains that the fake has no Temporal client', () => {
    expect(() => createFakeClient().temporal).toThrow(/fake client/);
  });
});
