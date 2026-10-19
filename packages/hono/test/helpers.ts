import {
  TemporalUnavailableError,
  WorkflowClosedError,
  WorkflowNotFoundError,
  defineWorkflow,
  signal,
  type,
  update,
  type AnyWorkflowContract,
} from '@norn-ts/core';
import type { NornClient, WorkflowClient, WorkflowHandle } from '@norn-ts/client';

export const Payments = defineWorkflow({
  name: 'PaymentWorkflow',
  taskQueue: 'hono-unit',
  id: 'payment-{paymentId}',
  input: type<{ paymentId: string }>(),
  output: type<string>(),
  signals: { paid: signal<[{ amount: number }]>(), failed: signal<[reason: string]>('paymentFailed'), ping: signal() },
  updates: { capture: update<{ captured: number }, [amount: number]>() },
});

export const Shipments = defineWorkflow({
  name: 'ShipmentWorkflow',
  taskQueue: 'hono-unit',
  input: type<{ shipmentId: string }>(),
  signals: { delivered: signal<[at: string]>() },
});

export interface RecordedCall {
  kind: 'signal' | 'update';
  workflowType: string;
  workflowId: string;
  name: string;
  args: unknown[];
}

/**
 * A NornClient stand-in for unit tests. Workflow IDs decide the outcome:
 * `*closed*` → WorkflowClosedError, `*missing*` → WorkflowNotFoundError, `*down*` → TemporalUnavailableError.
 */
export function fakeClient(): NornClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const outcome = (workflowId: string) => {
    if (workflowId.includes('closed')) throw new WorkflowClosedError({ workflowId, closeStatus: 'COMPLETED' });
    if (workflowId.includes('missing')) throw new WorkflowNotFoundError({ workflowId });
    if (workflowId.includes('down')) throw new TemporalUnavailableError({ message: 'Temporal is unavailable: connect ECONNREFUSED' });
  };
  const workflow = <C extends AnyWorkflowContract>(contract: C): WorkflowClient<C> =>
    ({
      contract,
      get(target: { workflowId?: string }) {
        const workflowId = typeof target.workflowId === 'string' ? target.workflowId : contract.workflowId(target as never);
        const handle = {
          workflowId,
          runId: undefined,
          async signal(key: string, ...args: unknown[]) {
            outcome(workflowId);
            calls.push({ kind: 'signal', workflowType: contract.name, workflowId, name: contract.signals[key]?.name ?? key, args });
          },
          async update(key: string, ...args: unknown[]) {
            outcome(workflowId);
            calls.push({ kind: 'update', workflowType: contract.name, workflowId, name: contract.updates[key]?.name ?? key, args });
            return { captured: args[0], workflowId };
          },
        };
        return handle as unknown as WorkflowHandle<C>;
      },
    }) as unknown as WorkflowClient<C>;
  const client = {
    calls,
    workflow,
    temporal: undefined as never,
    connection: undefined as never,
    close: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
  return client as NornClient & { calls: RecordedCall[] };
}
