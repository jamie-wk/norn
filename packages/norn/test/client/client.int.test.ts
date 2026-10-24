import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  QueryFailedError,
  TemporalUnavailableError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowClosedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
} from '../../src/core/index.ts';
import { createLocalEnv, startWorkers, type RunningWorkers } from '../../../../tooling/test-support/temporal.ts';
import { createClient, type NornClient } from '../../src/client/index.ts';
import { CartWorkflow as Carts, EchoWorkflow as Echo, OrderWorkflow as Orders, TickWorkflow as Tick } from './fixtures/workflow-classes.ts';

const workflowsPath = fileURLToPath(new URL('./fixtures/workflows.ts', import.meta.url));

let env: TestWorkflowEnvironment;
let workers: RunningWorkers;
let norn: NornClient;

beforeAll(async () => {
  env = await createLocalEnv({ searchAttributes: { CustomerId: 'KEYWORD', OrderStatus: 'KEYWORD' } });
  workers = await startWorkers(env, { workflowsPath, taskQueues: ['client-orders'] });
  norn = createClient({ connection: env.connection, namespace: env.namespace ?? 'default' });
});

afterAll(async () => {
  await workers?.stop();
  await env?.teardown();
});

let n = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${n++}`;

describe('start, handlers and results', () => {
  it('starts from the contract ID template and runs signals, queries and updates', async () => {
    const orderId = uid('o');
    const handle = await norn.workflow(Orders).start({ orderId });
    expect(handle.workflowId).toBe(`order-${orderId}`);
    expect(handle.runId).toBeTypeOf('string');

    expect(await handle.update('addItem', 'sku-1')).toBe(1);
    expect(await handle.update('addItem', 'sku-2')).toBe(2);
    expect(await handle.query('getItems')).toEqual(['sku-1', 'sku-2']);
    expect(await handle.query('summary', 'now')).toBe('now:open:2');
    await handle.signal('close');
    expect(await handle.result()).toEqual({ status: 'closed', items: ['sku-1', 'sku-2'], reason: '' });
  });

  it('executes workflows without an ID template when given an explicit ID', async () => {
    expect(await norn.workflow(Echo).execute({ value: 'hi' }, { workflowId: uid('echo') })).toBe('HI');
    expect(await norn.workflow(Tick).execute(undefined, { workflowId: uid('tick') })).toBe('tick');
  });

  it('gets handles by ID fields or explicit IDs', async () => {
    const orderId = uid('o');
    await norn.workflow(Orders).start({ orderId });
    await norn.workflow(Orders).get({ orderId }).update('addItem', 'a');
    expect(await norn.workflow(Orders).get({ workflowId: `order-${orderId}` }).query('getItems')).toEqual(['a']);
    await norn.workflow(Orders).get({ orderId }).signal('cancel', 'done');
  });

  it('describes workflows with typed search attributes', async () => {
    const orderId = uid('o');
    const handle = await norn.workflow(Orders).start({ orderId, customerId: 'c-77' }, { searchAttributes: { CustomerId: 'c-77' } });
    await expect.poll(async () => (await handle.describe()).searchAttributes.OrderStatus, { timeout: 10_000 }).toBe('open');
    const running = await handle.describe();
    expect(running).toMatchObject({ workflowId: `order-${orderId}`, type: 'OrderWorkflow', status: 'RUNNING', taskQueue: 'client-orders' });
    expect(running.searchAttributes.CustomerId).toBe('c-77');
    await handle.signal('close');
    await handle.result();
    const closed = await handle.describe();
    expect(closed.status).toBe('COMPLETED');
    expect(closed.closeTime).toBeInstanceOf(Date);
    expect(closed.searchAttributes.OrderStatus).toBe('closed');
  });

  it('lists workflows of the contract type by visibility query', async () => {
    const customer = uid('cust');
    const orderId = uid('o');
    await norn.workflow(Orders).start({ orderId, customerId: customer }, { searchAttributes: { CustomerId: customer } });
    await expect
      .poll(
        async () => {
          const ids: string[] = [];
          for await (const w of norn.workflow(Orders).list(`CustomerId = "${customer}"`)) ids.push(w.workflowId);
          return ids;
        },
        { timeout: 15_000 },
      )
      .toEqual([`order-${orderId}`]);
    await norn.workflow(Orders).get({ orderId }).signal('close');
  });
});

describe('with-start operations', () => {
  it('signal-with-start creates the workflow once and signals it each time', async () => {
    const cartId = uid('cart');
    const first = await norn.workflow(Carts).signalWithStart({ cartId }, { signal: 'push', args: ['a'] });
    const second = await norn.workflow(Carts).signalWithStart({ cartId }, { signal: 'push', args: ['b'] });
    expect(second.workflowId).toBe(first.workflowId);
    await expect.poll(() => first.query('list')).toEqual(['a', 'b']);
    await first.signal('checkout');
    expect(await first.result()).toEqual(['a', 'b']);
  });

  it('update-with-start creates the workflow once and returns each update result', async () => {
    const cartId = uid('cart');
    const one = await norn.workflow(Carts).updateWithStart({ cartId }, { update: 'add', args: ['x'] });
    expect(one.result).toEqual(['x']);
    const two = await norn.workflow(Carts).updateWithStart({ cartId }, { update: 'add', args: ['y'] });
    expect(two.result).toEqual(['x', 'y']);
    expect(one.handle.runId).toBeTypeOf('string');
    expect(two.handle.runId).toBe(one.handle.runId);
    await two.handle.signal('checkout');
  });

  it('update-with-start with ifRunning: fail is a 409 for a running workflow', async () => {
    const cartId = uid('cart');
    const first = await norn.workflow(Carts).updateWithStart({ cartId }, { update: 'add', args: ['x'] });
    const again = norn.workflow(Carts).updateWithStart({ cartId }, { update: 'add', args: ['y'] }, { ifRunning: 'fail' });
    await expect(again).rejects.toBeInstanceOf(WorkflowAlreadyStartedError);
    await first.handle.signal('checkout');
  });

  it('update-with-start surfaces validator rejections', async () => {
    const orderId = uid('o');
    const attempt = norn.workflow(Orders).updateWithStart({ orderId }, { update: 'addItem', args: [''] });
    await expect(attempt).rejects.toBeInstanceOf(UpdateRejectedError);
    // The workflow still started; the update was rejected without changing state.
    expect(await norn.workflow(Orders).get({ orderId }).query('getItems')).toEqual([]);
    await norn.workflow(Orders).get({ orderId }).signal('close');
  });
});

describe('ID policies', () => {
  it('rejects a duplicate start with 409', async () => {
    const orderId = uid('o');
    await norn.workflow(Orders).start({ orderId });
    const dup = norn.workflow(Orders).start({ orderId });
    await expect(dup).rejects.toBeInstanceOf(WorkflowAlreadyStartedError);
    await expect(dup).rejects.toMatchObject({ status: 409, workflowId: `order-${orderId}` });
    await norn.workflow(Orders).get({ orderId }).signal('close');
  });

  it('returns the running workflow with ifRunning: useExisting', async () => {
    const orderId = uid('o');
    const a = await norn.workflow(Orders).start({ orderId });
    const b = await norn.workflow(Orders).start({ orderId }, { ifRunning: 'useExisting' });
    expect(b.runId).toBe(a.runId);
    await a.signal('close');
  });

  it('replaces the running workflow with ifRunning: terminateExisting', async () => {
    const orderId = uid('o');
    const a = await norn.workflow(Orders).start({ orderId });
    const b = await norn.workflow(Orders).start({ orderId }, { ifRunning: 'terminateExisting' });
    expect(b.runId).not.toBe(a.runId);
    await expect(a.result()).rejects.toMatchObject({ failureType: 'Terminated' });
    await b.signal('close');
  });

  it('refuses to reuse a closed ID with ifClosed: reject', async () => {
    const orderId = uid('o');
    const a = await norn.workflow(Orders).start({ orderId });
    await a.signal('close');
    await a.result();
    await expect(norn.workflow(Orders).start({ orderId }, { ifClosed: 'reject' })).rejects.toBeInstanceOf(WorkflowAlreadyStartedError);
    const again = await norn.workflow(Orders).start({ orderId });
    await again.signal('close');
  });
});

describe('sad paths', () => {
  it('reports unknown workflows as 404 for every operation', async () => {
    const ghost = norn.workflow(Orders).get({ orderId: uid('ghost') });
    await expect(ghost.signal('close')).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.query('getItems')).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.update('addItem', 'a')).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.describe()).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.result()).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(ghost.cancel()).rejects.toMatchObject({ status: 404 });
  });

  it('reports signals and updates to closed workflows as 409 WorkflowClosedError', async () => {
    const orderId = uid('o');
    const handle = await norn.workflow(Orders).start({ orderId });
    await handle.signal('close');
    await handle.result();
    const signal = handle.signal('cancel', 'late');
    await expect(signal).rejects.toBeInstanceOf(WorkflowClosedError);
    await expect(signal).rejects.toMatchObject({ status: 409, closeStatus: 'COMPLETED' });
    await expect(handle.update('addItem', 'late')).rejects.toBeInstanceOf(WorkflowClosedError);
    // Queries still work on closed workflows while a worker is available.
    expect(await handle.query('getItems')).toEqual([]);
  });

  it('maps validator and handler failures to 422 UpdateRejectedError', async () => {
    const handle = await norn.workflow(Orders).start({ orderId: uid('o') });
    const invalid = await handle.update('addItem', '').catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(UpdateRejectedError);
    expect(invalid).toMatchObject({ status: 422, failureType: 'InvalidItemError', message: 'sku is required', update: 'addItem' });
    const boom = await handle.update('addItem', 'boom').catch((e: unknown) => e);
    expect(boom).toMatchObject({ failureType: 'OutOfStockError', message: 'out of stock' });
    expect(await handle.query('getItems')).toEqual([]);
    await handle.signal('close');
  });

  it('maps failed runs to WorkflowFailedError with the failure type', async () => {
    const handle = await norn.workflow(Orders).start({ orderId: uid('o'), failWith: 'PaymentDeclined' });
    await handle.signal('close');
    const error = await handle.result().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(error).toMatchObject({ failureType: 'PaymentDeclined', message: 'failed: PaymentDeclined' });
    expect((await handle.describe()).status).toBe('FAILED');
  });

  it('cancels and terminates', async () => {
    const canceled = await norn.workflow(Orders).start({ orderId: uid('o') });
    await canceled.cancel();
    await expect(canceled.result()).rejects.toMatchObject({ failureType: 'Cancelled' });
    expect((await canceled.describe()).status).toBe('CANCELLED');

    const terminated = await norn.workflow(Orders).start({ orderId: uid('o') });
    await terminated.terminate('ops cleanup');
    await expect(terminated.result()).rejects.toMatchObject({ failureType: 'Terminated' });
    expect((await terminated.describe()).status).toBe('TERMINATED');
  });

  it('reports a failing query handler as QueryFailedError, and an unknown query before calling', async () => {
    const handle = await norn.workflow(Orders).start({ orderId: uid('o') });
    await expect(handle.query('broken')).rejects.toBeInstanceOf(QueryFailedError);
    await expect((handle.query as (key: string) => Promise<unknown>)('nope')).rejects.toThrow(/no @Query method "nope"/);
    await handle.signal('close');
  });

  it('reports an unreachable server as 503 TemporalUnavailableError', async () => {
    await using offline = createClient({ address: '127.0.0.1:1', connectTimeout: '1s' });
    const error = await offline.workflow(Echo).start({ value: 'x' }, { workflowId: 'never' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemporalUnavailableError);
    expect(error).toMatchObject({ status: 503 });
  }, 60_000);
});
