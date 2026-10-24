// Scenarios that the fake client and the real client must agree on. Run against createFakeClient()
// in fake-client.test.ts and against a real server in client-conformance.int.test.ts.
import { expect, it } from 'vitest';
import { NornConfigError, QueryFailedError, UpdateRejectedError, WorkflowAlreadyStartedError, WorkflowClosedError, WorkflowNotFoundError } from '@norn-ts/core';
import type { NornClient } from '@norn-ts/client';
import { Counters } from './fixtures/contracts.ts';

export interface ConformanceTarget {
  norn: NornClient;
  /** Ends a running counter, so it is closed. */
  finish(counterId: string): Promise<void>;
}

let n = 0;
const id = () => `c-${Date.now()}-${n++}`;

export function clientConformance(target: () => ConformanceTarget) {
  const counters = () => target().norn.workflow(Counters);

  it('rejects a second start of a running workflow with WorkflowAlreadyStartedError', async () => {
    const counterId = id();
    await counters().start({ counterId });
    await expect(counters().start({ counterId })).rejects.toThrow(WorkflowAlreadyStartedError);
  });

  it('reports an unknown workflow with WorkflowNotFoundError', async () => {
    await expect(counters().get({ counterId: id() }).signal('finish')).rejects.toThrow(WorkflowNotFoundError);
  });

  it('reports updates to a finished workflow with WorkflowClosedError', async () => {
    const counterId = id();
    await counters().start({ counterId });
    await target().finish(counterId);
    await expect(counters().get({ counterId }).update('add', 1)).rejects.toThrow(WorkflowClosedError);
  });

  it('returns accepted updates and rejects refused ones with UpdateRejectedError', async () => {
    const order = await counters().start({ counterId: id() });
    expect(await order.update('add', 2)).toBe(2);
    const rejected = order.update('add', -1);
    await expect(rejected).rejects.toThrow(UpdateRejectedError);
    await expect(rejected).rejects.toMatchObject({ failureType: 'NegativeError', status: 422 });
  });

  it('reports a failing query with QueryFailedError', async () => {
    const order = await counters().start({ counterId: id() });
    await expect(order.query('broken')).rejects.toThrow(QueryFailedError);
  });

  it('validates start options before calling Temporal', async () => {
    await expect(counters().start({ counterId: id() }, { ifRunning: 'nope' as never })).rejects.toThrow(NornConfigError);
    await expect(counters().start({ counterId: id() }, { searchAttributes: { Nope: 'x' } as never })).rejects.toThrow(NornConfigError);
    await expect(counters().start({ counterId: id() }, { executionTimeout: 'soon' as never })).rejects.toThrow(NornConfigError);
  });
}
