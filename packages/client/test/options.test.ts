import { describe, expect, it } from 'vitest';
import { NornConfigError, defineWorkflow, type } from '@norn-ts/core';
import { startOptions, toTypedSearchAttributes } from '../src/index.ts';
import { Echo, Orders } from './fixtures/contracts.ts';

describe('startOptions', () => {
  it('derives the workflow ID, task queue and args from the contract', () => {
    const opts = startOptions(Orders, { orderId: 'o1' });
    expect(opts).toMatchObject({ workflowId: 'order-o1', taskQueue: 'client-orders', args: [{ orderId: 'o1' }] });
    expect(opts.workflowIdConflictPolicy).toBeUndefined();
  });

  it('lets callers override the ID and task queue', () => {
    const opts = startOptions(Orders, { orderId: 'o1' }, { workflowId: 'custom', taskQueue: 'other' });
    expect(opts).toMatchObject({ workflowId: 'custom', taskQueue: 'other' });
  });

  it('requires an explicit ID when the contract has no template', () => {
    expect(() => startOptions(Echo, { value: 'x' })).toThrow(/EchoWorkflow has no ID template/);
    expect(startOptions(Echo, { value: 'x' }, { workflowId: 'echo-1' }).workflowId).toBe('echo-1');
  });

  it('reports missing ID fields', () => {
    expect(() => startOptions(Orders, {} as never)).toThrow(NornConfigError);
  });

  it('passes no args for workflows without input', () => {
    const NoInput = defineWorkflow({ name: 'NoInput', taskQueue: 'q', output: type<string>() });
    expect(startOptions(NoInput, undefined, { workflowId: 'n' }).args).toEqual([]);
  });

  it.each([
    ['fail', 'FAIL'],
    ['useExisting', 'USE_EXISTING'],
    ['terminateExisting', 'TERMINATE_EXISTING'],
  ] as const)('maps ifRunning %s', (ifRunning, policy) => {
    expect(startOptions(Orders, { orderId: 'o' }, { ifRunning }).workflowIdConflictPolicy).toBe(policy);
  });

  it.each([
    ['allow', 'ALLOW_DUPLICATE'],
    ['allowIfFailed', 'ALLOW_DUPLICATE_FAILED_ONLY'],
    ['reject', 'REJECT_DUPLICATE'],
  ] as const)('maps ifClosed %s', (ifClosed, policy) => {
    expect(startOptions(Orders, { orderId: 'o' }, { ifClosed }).workflowIdReusePolicy).toBe(policy);
  });

  it('rejects unknown policies', () => {
    expect(() => startOptions(Orders, { orderId: 'o' }, { ifRunning: 'maybe' as never })).toThrow(NornConfigError);
    expect(() => startOptions(Orders, { orderId: 'o' }, { ifClosed: 'never' as never })).toThrow(NornConfigError);
    expect(() => startOptions(Orders, { orderId: 'o' }, { ifRunning: 'toString' as never })).toThrow(NornConfigError);
    expect(() => startOptions(Orders, { orderId: 'o' }, { ifClosed: 'toString' as never })).toThrow(NornConfigError);
  });

  it('converts durations and passes Temporal options through', () => {
    const opts = startOptions(Orders, { orderId: 'o' }, {
      executionTimeout: '1d',
      runTimeout: '2h',
      taskTimeout: '10s',
      startDelay: '5m',
      memo: { source: 'api' },
      summary: 'Order o',
    });
    expect(opts).toMatchObject({
      workflowExecutionTimeout: '86400000ms',
      workflowRunTimeout: '7200000ms',
      workflowTaskTimeout: '10000ms',
      startDelay: '300000ms',
      memo: { source: 'api' },
      staticSummary: 'Order o',
    });
  });

  it('rejects invalid durations', () => {
    expect(() => startOptions(Orders, { orderId: 'o' }, { executionTimeout: 'soon' as never })).toThrow(NornConfigError);
  });
});

describe('toTypedSearchAttributes', () => {
  it('builds typed pairs from contract declarations', () => {
    const pairs = toTypedSearchAttributes(Orders, { CustomerId: 'c1', OrderStatus: 'open' });
    expect(pairs.map((p) => [p.key.name, p.key.type, p.value])).toEqual([
      ['CustomerId', 'KEYWORD', 'c1'],
      ['OrderStatus', 'KEYWORD', 'open'],
    ]);
  });

  it('skips undefined values', () => {
    expect(toTypedSearchAttributes(Orders, { CustomerId: undefined })).toEqual([]);
  });

  it('rejects attributes the contract does not declare', () => {
    expect(() => toTypedSearchAttributes(Orders, { Nope: 'x' } as never)).toThrow(/does not declare search attribute Nope/);
  });

  it('rejects values of the wrong type', () => {
    expect(() => toTypedSearchAttributes(Orders, { CustomerId: 5 } as never)).toThrow(/CustomerId.*keyword/);
  });

  it('rejects non-finite doubles, as workflows do', () => {
    const Scores = defineWorkflow({ name: 'Scores', taskQueue: 'q', input: type<{ id: string }>(), searchAttributes: { Score: 'double' } });
    expect(toTypedSearchAttributes(Scores, { Score: 1.5 })).toHaveLength(1);
    expect(() => toTypedSearchAttributes(Scores, { Score: Number.NaN })).toThrow(/Score.*double/);
    expect(() => toTypedSearchAttributes(Scores, { Score: Number.POSITIVE_INFINITY })).toThrow(/Score.*double/);
  });
});
