import {
  NornConfigError,
  NornError,
  QueryFailedError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowClosedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  type AnyWorkflowContract,
  type ContractInput,
  type ContractOutput,
  type RefArgs,
  type RefResult,
  errorTypeOf,
} from '@norn-ts/core';
import { resolveWorkflowId, startOptions, type NornClient, type StartOptions, type WorkflowClient, type WorkflowHandle, type WorkflowStatus, type WorkflowSummary } from '@norn-ts/client';

type Keys<R> = keyof R & string;
type Args<R> = RefArgs<R> extends infer A extends unknown[] ? A : never;

export interface FakeStub<C extends AnyWorkflowContract> {
  signals?: { [K in Keys<C['signals']>]?: (...args: Args<C['signals'][K]>) => void };
  queries?: { [K in Keys<C['queries']>]?: (...args: Args<C['queries'][K]>) => RefResult<C['queries'][K]> };
  updates?: { [K in Keys<C['updates']>]?: (...args: Args<C['updates'][K]>) => RefResult<C['updates'][K]> | Promise<RefResult<C['updates'][K]>> };
  /** Called for each start, e.g. to complete immediately with `fake.complete()`. */
  onStart?: (input: ContractInput<C>, workflowId: string) => void;
}

export type FakeOp = 'start' | 'signal' | 'query' | 'update' | 'cancel' | 'terminate' | 'signalWithStart' | 'updateWithStart';

export interface FakeCall {
  op: FakeOp;
  workflow: string;
  workflowId: string;
  name?: string;
  args?: unknown[];
  input?: unknown;
  options?: unknown;
}

interface Execution {
  workflow: string;
  workflowId: string;
  runId: string;
  input: unknown;
  status: WorkflowStatus;
  startTime: Date;
  closeTime: Date | undefined;
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
  waiters: Array<() => void>;
}

export interface FakeNornClient extends NornClient {
  /** Every call made through the fake, in order. */
  readonly calls: FakeCall[];
  /** Inputs of every new execution of a contract (including with-start), not reused or rejected starts. */
  started<C extends AnyWorkflowContract>(contract: C): ContractInput<C>[];
  stub<C extends AnyWorkflowContract>(contract: C, stub: FakeStub<C>): void;
  /** Completes the latest run of a workflow ID with a result. */
  complete(workflowId: string, result: unknown): void;
  /** Fails the latest run with an ApplicationFailure-like type and message. */
  fail(workflowId: string, failureType: string, message?: string): void;
  /** Makes the next call reject with this error (e.g. `TemporalUnavailableError`). */
  failNext(error: unknown): void;
  reset(): void;
}

let runCounter = 0;

/** A stub's error as the real client would surface it: NornErrors as they are, anything else wrapped. */
function asNornError(error: unknown, wrap: (message: string) => NornError): unknown {
  return error instanceof NornError ? error : wrap(error instanceof Error ? error.message : String(error));
}

/** Runs an update stub; a throw means the workflow rejected the update, as with a validator. */
async function runUpdate(fn: (...a: unknown[]) => unknown, args: unknown[], workflowId: string, update: string): Promise<unknown> {
  try {
    return await fn(...args);
  } catch (error) {
    throw asNornError(error, (message) => new UpdateRejectedError({ workflowId, update, failureType: errorTypeOf(error), message, cause: error }));
  }
}

/**
 * An in-memory stand-in for `createClient()`, for unit-testing API routes without Temporal.
 * Enforces the same ID rules and errors as a real server: 409 for duplicates and closed
 * workflows, 404 for unknown ones.
 */
export function createFakeClient(): FakeNornClient {
  const calls: FakeCall[] = [];
  const executions = new Map<string, Execution>();
  // Every run, including replaced ones: `executions` keeps only the latest per ID.
  const runs: Execution[] = [];
  const stubs = new Map<string, FakeStub<any>>();
  const pendingFailures: unknown[] = [];

  const takeFailure = () => {
    if (pendingFailures.length) throw pendingFailures.shift();
  };
  const find = (workflowId: string): Execution => {
    const exec = executions.get(workflowId);
    if (!exec) throw new WorkflowNotFoundError({ workflowId });
    return exec;
  };
  const running = (workflowId: string): Execution => {
    const exec = find(workflowId);
    if (exec.status !== 'RUNNING') throw new WorkflowClosedError({ workflowId, closeStatus: exec.status });
    return exec;
  };
  const close = (exec: Execution, status: WorkflowStatus, outcome: Execution['outcome']) => {
    exec.status = status;
    exec.closeTime = new Date();
    exec.outcome = outcome;
    for (const wake of exec.waiters.splice(0)) wake();
  };
  const summary = <C extends AnyWorkflowContract>(exec: Execution): WorkflowSummary<C> => ({
    workflowId: exec.workflowId,
    runId: exec.runId,
    type: exec.workflow,
    status: exec.status,
    taskQueue: 'fake',
    startTime: exec.startTime,
    closeTime: exec.closeTime,
    historyLength: 0,
    searchAttributes: {} as never,
    memo: undefined,
  });

  const startExecution = (contract: AnyWorkflowContract, input: unknown, opts: StartOptions = {}, reuseRunning = false): Execution => {
    // The real client's validation: bad ifRunning/ifClosed, search attributes and durations throw here too.
    const { workflowId } = startOptions(contract, input, opts);
    const existing = executions.get(workflowId);
    if (existing?.status === 'RUNNING') {
      if (reuseRunning || opts.ifRunning === 'useExisting') return existing;
      if (opts.ifRunning === 'terminateExisting') close(existing, 'TERMINATED', { ok: false, error: failed(existing, 'Terminated', 'terminated') });
      else throw new WorkflowAlreadyStartedError({ workflowId, workflowType: contract.name });
    } else if (existing && opts.ifClosed === 'reject') {
      throw new WorkflowAlreadyStartedError({ workflowId, workflowType: contract.name });
    } else if (existing && opts.ifClosed === 'allowIfFailed' && existing.status === 'COMPLETED') {
      throw new WorkflowAlreadyStartedError({ workflowId, workflowType: contract.name });
    }
    const exec: Execution = {
      workflow: contract.name,
      workflowId,
      runId: `fake-run-${++runCounter}`,
      input,
      status: 'RUNNING',
      startTime: new Date(),
      closeTime: undefined,
      outcome: undefined,
      waiters: [],
    };
    executions.set(workflowId, exec);
    runs.push(exec);
    stubs.get(contract.name)?.onStart?.(input as never, workflowId);
    return exec;
  };

  const failed = (exec: Execution, failureType: string, message: string) =>
    new WorkflowFailedError({ workflowId: exec.workflowId, failureType, message });

  const handleFor = <C extends AnyWorkflowContract>(contract: C, workflowId: string, runId: string | undefined): WorkflowHandle<C> => {
    const stub = () => stubs.get(contract.name) ?? {};
    const log = (op: FakeOp, name?: string, args?: unknown[]) => calls.push({ op, workflow: contract.name, workflowId, ...(name ? { name } : {}), ...(args ? { args } : {}) });
    return {
      workflowId,
      runId,
      get temporal(): never {
        throw new NornConfigError('The fake client has no Temporal handle');
      },
      async signal(key, ...args) {
        log('signal', key, args);
        takeFailure();
        running(workflowId);
        (stub().signals?.[key] as ((...a: unknown[]) => void) | undefined)?.(...args);
      },
      async query(key, ...args) {
        log('query', key, args);
        takeFailure();
        find(workflowId);
        const fn = stub().queries?.[key] as ((...a: unknown[]) => unknown) | undefined;
        if (!fn) throw new NornConfigError(`No fake query ${key} for ${contract.name}; add it with fake.stub()`);
        try {
          return fn(...args) as never;
        } catch (error) {
          throw asNornError(error, (message) => new QueryFailedError({ workflowId, query: key, message, cause: error }));
        }
      },
      async update(key, ...args) {
        log('update', key, args);
        takeFailure();
        running(workflowId);
        const fn = stub().updates?.[key] as ((...a: unknown[]) => unknown) | undefined;
        if (!fn) throw new NornConfigError(`No fake update ${key} for ${contract.name}; add it with fake.stub()`);
        return (await runUpdate(fn, args, workflowId, key)) as never;
      },
      async result() {
        takeFailure();
        const exec = find(workflowId);
        if (!exec.outcome) await new Promise<void>((resolve) => exec.waiters.push(resolve));
        const outcome = exec.outcome!;
        if (outcome.ok) return outcome.value as ContractOutput<C>;
        throw outcome.error;
      },
      async cancel() {
        log('cancel');
        takeFailure();
        const exec = running(workflowId);
        close(exec, 'CANCELLED', { ok: false, error: failed(exec, 'Cancelled', 'cancelled') });
      },
      async terminate(reason) {
        log('terminate', undefined, reason === undefined ? [] : [reason]);
        takeFailure();
        const exec = running(workflowId);
        close(exec, 'TERMINATED', { ok: false, error: failed(exec, 'Terminated', reason ?? 'terminated') });
      },
      async describe() {
        takeFailure();
        return summary<C>(find(workflowId));
      },
    };
  };

  const workflow = <C extends AnyWorkflowContract>(contract: C): WorkflowClient<C> => {
    if (contract?.kind !== 'norn.workflow') throw new NornConfigError('workflow() expects a contract');
    const startWith = (op: FakeOp, input: unknown, opts: StartOptions<C> | undefined, reuse: boolean) => {
      const { workflowId } = startOptions(contract, input, opts);
      calls.push({ op, workflow: contract.name, workflowId, input, ...(opts && Object.keys(opts).length ? { options: opts } : {}) });
      takeFailure();
      return startExecution(contract, input, opts, reuse);
    };
    const client: WorkflowClient<C> = {
      contract,
      start: (async (input?: unknown, opts?: StartOptions<C>) => {
        const exec = startWith('start', input, opts, false);
        return handleFor(contract, exec.workflowId, exec.runId);
      }) as WorkflowClient<C>['start'],
      execute: (async (input?: unknown, opts?: StartOptions<C>) => {
        const exec = startWith('start', input, opts, false);
        return handleFor(contract, exec.workflowId, exec.runId).result();
      }) as WorkflowClient<C>['execute'],
      get(target) {
        const explicit = typeof (target as { workflowId?: unknown }).workflowId === 'string';
        const workflowId = explicit ? (target as { workflowId: string }).workflowId : resolveWorkflowId(contract, target);
        return handleFor(contract, workflowId, explicit ? (target as { runId?: string }).runId : undefined);
      },
      async signalWithStart(input, operation, opts) {
        const exec = startWith('signalWithStart', input, opts, true);
        calls.at(-1)!.name = operation.signal;
        calls.at(-1)!.args = operation.args as unknown[];
        (stubs.get(contract.name)?.signals?.[operation.signal] as ((...a: unknown[]) => void) | undefined)?.(...(operation.args as unknown[]));
        return handleFor(contract, exec.workflowId, exec.runId);
      },
      async updateWithStart(input, operation, opts) {
        const exec = startWith('updateWithStart', input, { ifRunning: 'useExisting', ...opts }, false);
        calls.at(-1)!.name = operation.update;
        calls.at(-1)!.args = operation.args as unknown[];
        const fn = stubs.get(contract.name)?.updates?.[operation.update] as ((...a: unknown[]) => unknown) | undefined;
        if (!fn) throw new NornConfigError(`No fake update ${operation.update} for ${contract.name}; add it with fake.stub()`);
        const result = await runUpdate(fn, operation.args as unknown[], exec.workflowId, operation.update);
        return { handle: handleFor(contract, exec.workflowId, exec.runId), result: result as never };
      },
      list() {
        const items = [...executions.values()].filter((e) => e.workflow === contract.name);
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of items) yield summary<C>(e);
          },
        };
      },
      async count() {
        return [...executions.values()].filter((e) => e.workflow === contract.name).length;
      },
    };
    return client;
  };

  const latest = (workflowId: string): Execution => {
    const exec = executions.get(workflowId);
    if (!exec) throw new NornConfigError(`The fake client has no workflow ${workflowId}`);
    return exec;
  };

  return {
    calls,
    workflow,
    get temporal(): never {
      throw new NornConfigError('This is a fake client; there is no Temporal client behind it');
    },
    get connection(): never {
      throw new NornConfigError('This is a fake client; there is no connection behind it');
    },
    started: (contract) => runs.filter((r) => r.workflow === contract.name).map((r) => r.input as never),
    stub: (contract, stub) => void stubs.set(contract.name, stub),
    complete(workflowId, result) {
      close(latest(workflowId), 'COMPLETED', { ok: true, value: result });
    },
    fail(workflowId, failureType, message = failureType) {
      const exec = latest(workflowId);
      close(exec, 'FAILED', { ok: false, error: failed(exec, failureType, message) });
    },
    failNext: (error) => void pendingFailures.push(error),
    reset() {
      calls.length = 0;
      executions.clear();
      runs.length = 0;
      stubs.clear();
      pendingFailures.length = 0;
    },
    close: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
}
