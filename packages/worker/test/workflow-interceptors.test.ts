import { describe, expect, it } from 'vitest';
import { CORRELATION_HEADER } from '@norn/core';
import { interceptors } from '../src/workflow-interceptors.ts';

const header = { metadata: {}, data: new Uint8Array([1, 2, 3]) };

describe('workflow correlation interceptors', () => {
  it('copies the correlation header from the workflow start to outbound calls', async () => {
    const { inbound, outbound } = interceptors();
    const execute = inbound![0]!.execute!;
    await execute({ headers: { [CORRELATION_HEADER]: header }, args: [] } as never, async () => 'done');
    for (const method of ['scheduleActivity', 'scheduleLocalActivity', 'startChildWorkflowExecution', 'signalWorkflow', 'continueAsNew'] as const) {
      let seen: Record<string, unknown> | undefined;
      await (outbound![0]![method] as (i: unknown, n: unknown) => Promise<unknown>)({ headers: {} }, async (i: { headers: Record<string, unknown> }) => {
        seen = i.headers;
      });
      expect(seen![CORRELATION_HEADER]).toBe(header);
    }
  });

  it('does nothing without a correlation header and keeps explicit headers', async () => {
    const { inbound, outbound } = interceptors();
    await inbound![0]!.execute!({ headers: {}, args: [] } as never, async () => undefined);
    let seen: Record<string, unknown> | undefined;
    await outbound![0]!.scheduleActivity!({ headers: { other: header } } as never, async (i) => {
      seen = i.headers;
      return undefined;
    });
    expect(seen).toEqual({ other: header });
  });
});
