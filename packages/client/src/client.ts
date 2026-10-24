import { readFileSync } from 'node:fs';
import {
  Client,
  Connection,
  WithStartWorkflowOperation,
  WorkflowUpdateStage,
  type ConnectionLike,
  type ConnectionOptions,
  type DataConverter,
  type WorkflowClientInterceptor,
  type WorkflowExecutionDescription,
  type WorkflowExecutionInfo,
  type WorkflowHandle as TemporalHandle,
} from '@temporalio/client';
import {
  NornConfigError,
  WorkflowClosedError,
  WorkflowNotFoundError,
  connectionSettings,
  formatDuration,
  type AnyWorkflowContract,
  type ContractInput,
  type ContractOutput,
  type Duration,
  type IdParams,
  type RefArgs,
  type RefResult,
  type SearchAttributeValues,
} from '@norn-ts/core';
import { correlationInterceptor, runWithCorrelationId } from './correlation.js';
import { toNornError, type ErrorContext } from './errors.js';
import { resolveWorkflowId, startOptions, type StartOptions } from './options.js';

export interface ClientOptions {
  /**
   * Wrap an existing Temporal client instead of creating one, e.g. a test environment's
   * time-skipping client. Its interceptors are used as-is (no correlation interceptor is added).
   */
  client?: Client;
  /** An existing connection. When omitted, Norn opens a lazy one and closes it on `close()`. */
  connection?: Connection;
  /** Server address. Defaults to `TEMPORAL_ADDRESS`, then `localhost:7233`. */
  address?: string;
  /** Defaults to `TEMPORAL_NAMESPACE`, then `default`. */
  namespace?: string;
  /** Defaults to `TEMPORAL_API_KEY`. Setting an API key turns TLS on. */
  apiKey?: string;
  tls?: ConnectionOptions['tls'];
  connectTimeout?: Duration;
  /** Use `clientDataConverter()` from `@norn-ts/codec` for encrypted payloads. */
  dataConverter?: DataConverter;
  interceptors?: WorkflowClientInterceptor[];
  /** Add the correlation ID header to outbound calls. Default true. */
  correlation?: boolean;
}

export type WorkflowStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TERMINATED'
  | 'CONTINUED_AS_NEW'
  | 'TIMED_OUT'
  | 'PAUSED'
  | 'UNKNOWN';

export interface WorkflowSummary<C extends AnyWorkflowContract = AnyWorkflowContract> {
  workflowId: string;
  runId: string;
  type: string;
  status: WorkflowStatus;
  taskQueue: string;
  startTime: Date;
  closeTime: Date | undefined;
  historyLength: number;
  searchAttributes: SearchAttributeValues<C>;
  memo: Record<string, unknown> | undefined;
}

type Keys<R> = keyof R & string;
type Args<R> = RefArgs<R> extends infer A extends unknown[] ? A : never;
type InputArgs<C extends AnyWorkflowContract> = undefined extends ContractInput<C>
  ? [input?: ContractInput<C>, options?: StartOptions<C>]
  : [input: ContractInput<C>, options?: StartOptions<C>];
export type HandleTarget<C extends AnyWorkflowContract> = IdParams<C> | { workflowId: string; runId?: string };

export interface SignalOperation<C extends AnyWorkflowContract, K extends Keys<C['signals']>> {
  signal: K;
  args: Args<C['signals'][K]>;
}
export interface UpdateOperation<C extends AnyWorkflowContract, K extends Keys<C['updates']>> {
  update: K;
  args: Args<C['updates'][K]>;
}

export interface WorkflowHandle<C extends AnyWorkflowContract = AnyWorkflowContract> {
  readonly workflowId: string;
  /** The run this handle points at; for handles from `get()` without a run ID, the latest run. */
  readonly runId: string | undefined;
  signal<K extends Keys<C['signals']>>(key: K, ...args: Args<C['signals'][K]>): Promise<void>;
  query<K extends Keys<C['queries']>>(key: K, ...args: Args<C['queries'][K]>): Promise<RefResult<C['queries'][K]>>;
  update<K extends Keys<C['updates']>>(key: K, ...args: Args<C['updates'][K]>): Promise<RefResult<C['updates'][K]>>;
  /** Waits for the workflow to finish and returns its output. */
  result(): Promise<ContractOutput<C>>;
  /** Requests cancellation; the workflow decides how to clean up. */
  cancel(): Promise<void>;
  terminate(reason?: string): Promise<void>;
  describe(): Promise<WorkflowSummary<C>>;
  /** The underlying Temporal handle, for anything Norn does not wrap. */
  readonly temporal: TemporalHandle;
}

export interface WorkflowClient<C extends AnyWorkflowContract = AnyWorkflowContract> {
  readonly contract: C;
  start(...args: InputArgs<C>): Promise<WorkflowHandle<C>>;
  /** Starts the workflow and waits for its result. */
  execute(...args: InputArgs<C>): Promise<ContractOutput<C>>;
  /** A handle by ID fields (from the contract's template) or `{ workflowId, runId? }`. Makes no call. */
  get(target: HandleTarget<C>): WorkflowHandle<C>;
  /** Signals the workflow, starting it first if it is not running. */
  signalWithStart<K extends Keys<C['signals']>>(
    input: ContractInput<C>,
    operation: SignalOperation<C, K>,
    options?: StartOptions<C>,
  ): Promise<WorkflowHandle<C>>;
  /**
   * Runs an update, starting the workflow first if needed (default `ifRunning: 'useExisting'`).
   * Resolves once the update completes.
   */
  updateWithStart<K extends Keys<C['updates']>>(
    input: ContractInput<C>,
    operation: UpdateOperation<C, K>,
    options?: StartOptions<C>,
  ): Promise<{ handle: WorkflowHandle<C>; result: RefResult<C['updates'][K]> }>;
  /** Lists executions of this workflow type, optionally narrowed by a visibility query. */
  list(query?: string): AsyncIterable<WorkflowSummary<C>>;
  count(query?: string): Promise<number>;
}

export interface NornClient extends AsyncDisposable {
  workflow<C extends AnyWorkflowContract>(contract: C): WorkflowClient<C>;
  /** The underlying Temporal client. */
  readonly temporal: Client;
  readonly connection: ConnectionLike;
  close(): Promise<void>;
}

function searchAttributesOf(info: Pick<WorkflowExecutionInfo, 'typedSearchAttributes'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of info.typedSearchAttributes?.getAll() ?? []) out[pair.key.name] = pair.value;
  return out;
}

function summarize<C extends AnyWorkflowContract>(info: Omit<WorkflowExecutionInfo, 'raw'> | WorkflowExecutionDescription): WorkflowSummary<C> {
  return {
    workflowId: info.workflowId,
    runId: info.runId,
    type: info.type,
    status: (info.status?.name ?? 'UNKNOWN') as WorkflowStatus,
    taskQueue: info.taskQueue,
    startTime: info.startTime,
    closeTime: info.closeTime,
    historyLength: info.historyLength,
    searchAttributes: searchAttributesOf(info) as SearchAttributeValues<C>,
    memo: info.memo,
  };
}

function nameOf(refs: Record<string, { name: string }>, key: string): string {
  // Unknown keys are sent as-is, so `as never` escape hatches reach the server and fail there.
  return Object.hasOwn(refs, key) ? refs[key]!.name : key;
}

function isExplicitTarget(target: unknown): target is { workflowId: string; runId?: string } {
  return typeof target === 'object' && target !== null && typeof (target as { workflowId?: unknown }).workflowId === 'string';
}

/** Creates a typed Temporal client. Pass contracts from `.norn/contracts.ts` to `workflow()`. */
export function createClient(options: ClientOptions = {}): NornClient {
  const settings = connectionSettings(process.env, { ...options, tls: typeof options.tls === 'boolean' ? options.tls : undefined });
  const ownsConnection = options.connection === undefined && options.client === undefined;
  const connection =
    options.client?.connection ??
    options.connection ??
    Connection.lazy({
      address: settings.address,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      tls:
        typeof options.tls === 'object'
          ? options.tls
          : settings.clientCert
            ? { clientCertPair: { crt: readFileSync(settings.clientCert.certPath), key: readFileSync(settings.clientCert.keyPath) } }
            : settings.tls,
      ...(options.connectTimeout !== undefined ? { connectTimeout: formatDuration(options.connectTimeout) } : {}),
    });
  const interceptors = [...(options.correlation === false ? [] : [correlationInterceptor()]), ...(options.interceptors ?? [])];
  const temporal =
    options.client ??
    new Client({
    connection,
    namespace: settings.namespace,
    dataConverter: options.dataConverter,
    interceptors: { workflow: interceptors },
  });

  const call = async <T>(ctx: ErrorContext, fn: () => Promise<T>, correlationId?: string): Promise<T> => {
    try {
      return await (correlationId === undefined ? fn() : runWithCorrelationId(correlationId, fn));
    } catch (error) {
      throw toNornError(error, ctx);
    }
  };

  const wrap = <C extends AnyWorkflowContract>(contract: C, handle: TemporalHandle, runId: string | undefined): WorkflowHandle<C> => {
    const base: ErrorContext = { workflowId: handle.workflowId, runId, workflowType: contract.name };
    // Signals, updates and cancels to a finished workflow come back as "not found"; tell the
    // caller whether it never existed (404) or is already closed (409).
    const closedOrMissing = async (error: unknown): Promise<unknown> => {
      if (!(error instanceof WorkflowNotFoundError)) return error;
      try {
        const description = await handle.describe();
        const status = description.status.name;
        if (status !== 'RUNNING') return new WorkflowClosedError({ workflowId: handle.workflowId, closeStatus: status, cause: error });
      } catch {
        // Not found at all: keep the 404.
      }
      return error;
    };
    const guarded = async <T>(ctx: ErrorContext, fn: () => Promise<T>): Promise<T> => {
      try {
        return await call(ctx, fn);
      } catch (error) {
        throw await closedOrMissing(error);
      }
    };
    return {
      workflowId: handle.workflowId,
      runId,
      temporal: handle,
      signal: (key, ...args) => guarded(base, () => handle.signal(nameOf(contract.signals, key), ...(args as unknown[]))),
      query: (key, ...args) => {
        const query = nameOf(contract.queries, key);
        return call({ ...base, query }, () => handle.query(query, ...(args as unknown[]))) as Promise<never>;
      },
      update: (key, ...args) => {
        const update = nameOf(contract.updates, key);
        return guarded({ ...base, update }, () => handle.executeUpdate(update, { args: args as never })) as Promise<never>;
      },
      result: () => call(base, () => handle.result()) as Promise<ContractOutput<C>>,
      cancel: () => guarded(base, async () => void (await handle.cancel())),
      terminate: (reason) => guarded(base, async () => void (await handle.terminate(reason))),
      describe: () => call(base, async () => summarize<C>(await handle.describe())),
    };
  };

  const workflow = <C extends AnyWorkflowContract>(contract: C): WorkflowClient<C> => {
    if (contract?.kind !== 'norn.workflow') {
      throw new NornConfigError('workflow() expects a contract from .norn/contracts.ts, contract() or defineWorkflow()');
    }
    const typeQuery = `WorkflowType = ${JSON.stringify(contract.name)}`;
    const visibility = (query?: string) => (query ? `${typeQuery} AND (${query})` : typeQuery);

    const start = async (input: unknown, opts: StartOptions<C> = {}) => {
      const startOpts = startOptions(contract, input, opts);
      const ctx = { workflowId: startOpts.workflowId, workflowType: contract.name };
      const handle = await call(ctx, () => temporal.workflow.start(contract.name, startOpts as never), opts.correlationId);
      return wrap(contract, handle, handle.firstExecutionRunId);
    };

    return {
      contract,
      start: ((input?: unknown, opts?: StartOptions<C>) => start(input, opts)) as WorkflowClient<C>['start'],
      execute: (async (input?: unknown, opts?: StartOptions<C>) => (await start(input, opts)).result()) as WorkflowClient<C>['execute'],
      get(target) {
        const workflowId = isExplicitTarget(target) ? target.workflowId : resolveWorkflowId(contract, target);
        const runId = isExplicitTarget(target) ? target.runId : undefined;
        return wrap(contract, temporal.workflow.getHandle(workflowId, runId), runId);
      },
      async signalWithStart(input, operation, opts = {}) {
        const startOpts = startOptions(contract, input, opts);
        const ctx = { workflowId: startOpts.workflowId, workflowType: contract.name };
        const handle = await call(
          ctx,
          () =>
            temporal.workflow.signalWithStart(contract.name, {
              ...startOpts,
              signal: nameOf(contract.signals, operation.signal),
              signalArgs: operation.args as unknown[],
            } as never),
          opts.correlationId,
        );
        return wrap(contract, handle, handle.signaledRunId);
      },
      async updateWithStart(input, operation, opts = {}) {
        const startOpts = startOptions(contract, input, { ifRunning: 'useExisting', ...opts });
        const update = nameOf(contract.updates, operation.update);
        const ctx = { workflowId: startOpts.workflowId, workflowType: contract.name, update };
        const startWorkflowOperation = new WithStartWorkflowOperation(contract.name, startOpts as never);
        const { runId, result } = await call(
          ctx,
          async () => {
            const upd = await temporal.workflow.startUpdateWithStart(update, {
              args: operation.args as unknown[],
              startWorkflowOperation,
              waitForStage: WorkflowUpdateStage.ACCEPTED,
            });
            return { runId: upd.workflowRunId, result: await upd.result() };
          },
          opts.correlationId,
        );
        return { handle: wrap(contract, await startWorkflowOperation.workflowHandle(), runId), result: result as never };
      },
      list(query) {
        const iterable = temporal.workflow.list({ query: visibility(query) });
        return {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const info of iterable) yield summarize<C>(info);
            } catch (error) {
              throw toNornError(error, { workflowId: '', workflowType: contract.name });
            }
          },
        };
      },
      count: (query) => call({ workflowId: '', workflowType: contract.name }, async () => (await temporal.workflow.count(visibility(query))).count),
    };
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (ownsConnection) await connection.close();
  };
  return { workflow, temporal, connection, close, [Symbol.asyncDispose]: close };
}
