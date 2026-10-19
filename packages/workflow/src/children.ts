import {
  ParentClosePolicy,
  getExternalWorkflowHandle,
  startChild,
  type ChildWorkflowHandle,
} from '@temporalio/workflow';
import {
  NornConfigError,
  formatDuration,
  formatWorkflowId,
  isWorkflowContract,
  type AnyWorkflowContract,
  type ContractInput,
  type ContractOutput,
  type Duration,
  type IdParamsFor,
  type RefArgs,
  type WorkflowClass,
  type WorkflowInput,
  type WorkflowOutput,
} from '@norn/core';
import { describeWorkflow } from './definition.js';

export interface ChildOptions {
  /** Explicit workflow ID. Required when the child has no ID template. */
  workflowId?: string;
  /** What happens to the child when the parent closes. Defaults to `'terminate'`. */
  parentClosePolicy?: 'terminate' | 'abandon' | 'request-cancel';
  /** Override the child's task queue. */
  taskQueue?: string;
  executionTimeout?: Duration;
  runTimeout?: Duration;
  taskTimeout?: Duration;
  memo?: Record<string, unknown>;
}

type Target = WorkflowClass | AnyWorkflowContract;
type InputOf<T> = T extends AnyWorkflowContract ? ContractInput<T> : WorkflowInput<T>;
type OutputOf<T> = T extends AnyWorkflowContract ? ContractOutput<T> : WorkflowOutput<T>;
type InstanceOf<T> = T extends abstract new (...args: any[]) => infer I ? I : never;
type MethodKey<T> = { [K in keyof InstanceOf<T>]: InstanceOf<T>[K] extends (...args: any[]) => any ? K : never }[keyof InstanceOf<T>] &
  string;

/** Signal methods of a class target, or signal keys of a contract target. */
type SignalKey<T> = T extends AnyWorkflowContract ? keyof T['signals'] & string : Exclude<MethodKey<T>, 'run'>;
type SignalArgs<T, K> = T extends AnyWorkflowContract
  ? K extends keyof T['signals']
    ? RefArgs<T['signals'][K]>
    : never
  : K extends keyof InstanceOf<T>
    ? InstanceOf<T>[K] extends (...args: infer A) => any
      ? A
      : never
    : never;

type AsArgs<X> = X extends any[] ? X : never;

type StartArgs<T> = InputOf<T> extends undefined
  ? [input?: InputOf<T>, options?: ChildOptions]
  : [input: InputOf<T>, options?: ChildOptions];

export interface ChildHandle<T> {
  readonly workflowId: string;
  readonly firstExecutionRunId: string;
  result(): Promise<OutputOf<T>>;
  signal<K extends SignalKey<T>>(signal: K, ...args: AsArgs<SignalArgs<T, K>>): Promise<void>;
}

export interface ChildRef<T> {
  /** Starts the child and returns a handle once it is running. */
  start(...args: StartArgs<T>): Promise<ChildHandle<T>>;
  /** Starts the child and waits for its result. */
  execute(...args: StartArgs<T>): Promise<OutputOf<T>>;
}

export interface ExternalRef<T> {
  readonly workflowId: string;
  signal<K extends SignalKey<T>>(signal: K, ...args: AsArgs<SignalArgs<T, K>>): Promise<void>;
  cancel(): Promise<void>;
}

interface TargetInfo {
  name: string;
  taskQueue: string;
  idTemplate: string | undefined;
  signalName(key: string): string;
}

function info(target: Target): TargetInfo {
  if (isWorkflowContract(target)) {
    return {
      name: target.name,
      taskQueue: target.taskQueue,
      idTemplate: target.idTemplate,
      signalName: (key) => {
        const ref = (target.signals as Record<string, { name: string }>)[key];
        if (!ref) throw new NornConfigError(`Workflow ${target.name} has no signal "${key}"`);
        return ref.name;
      },
    };
  }
  const def = describeWorkflow(target);
  return {
    name: def.name,
    taskQueue: def.taskQueue,
    idTemplate: def.idTemplate,
    signalName: (key) => {
      const handler = def.signals.find((s) => s.method === key);
      if (!handler) throw new NornConfigError(`Workflow ${def.name} has no @Signal method "${key}"`);
      return handler.name;
    },
  };
}

const CLOSE_POLICY = {
  terminate: ParentClosePolicy.TERMINATE,
  abandon: ParentClosePolicy.ABANDON,
  'request-cancel': ParentClosePolicy.REQUEST_CANCEL,
} as const;

function wrapHandle<T>(handle: ChildWorkflowHandle<any>, target: TargetInfo): ChildHandle<T> {
  return {
    workflowId: handle.workflowId,
    firstExecutionRunId: handle.firstExecutionRunId,
    result: () => handle.result() as Promise<OutputOf<T>>,
    signal: (key, ...args) => handle.signal(target.signalName(key), ...(args as unknown[])),
  };
}

/**
 * Returns a typed reference for starting a child workflow. Accepts a `@Workflow` class from the
 * same bundle, or a contract for a workflow implemented elsewhere.
 */
export function useChild<T extends Target>(target: T, defaults: ChildOptions = {}): ChildRef<T> {
  const t = info(target);
  const start = async (input?: unknown, options: ChildOptions = {}) => {
    const o = { ...defaults, ...options };
    let workflowId = o.workflowId;
    if (workflowId === undefined && t.idTemplate !== undefined) workflowId = formatWorkflowId(t.idTemplate, input);
    const handle = await startChild(t.name, {
      args: input === undefined ? [] : [input],
      taskQueue: o.taskQueue ?? t.taskQueue,
      parentClosePolicy: CLOSE_POLICY[o.parentClosePolicy ?? 'terminate'],
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(o.executionTimeout !== undefined ? { workflowExecutionTimeout: formatDuration(o.executionTimeout) } : {}),
      ...(o.runTimeout !== undefined ? { workflowRunTimeout: formatDuration(o.runTimeout) } : {}),
      ...(o.taskTimeout !== undefined ? { workflowTaskTimeout: formatDuration(o.taskTimeout) } : {}),
      ...(o.memo !== undefined ? { memo: o.memo } : {}),
    });
    return wrapHandle<T>(handle, t);
  };
  return {
    start: (...args: StartArgs<T>) => start(args[0], args[1]),
    execute: async (...args: StartArgs<T>) => (await start(args[0], args[1])).result(),
  };
}

/**
 * Returns a typed handle to another running workflow, for signals and cancellation. Pass the
 * ID template's fields, or `{ workflowId }`.
 */
export function useExternal<T extends Target>(
  target: T,
  id: IdParamsFor<InputOf<T>, T extends AnyWorkflowContract ? T['idTemplate'] : string> | { workflowId: string; runId?: string },
): ExternalRef<T> {
  const t = info(target);
  const explicit = id as { workflowId?: string; runId?: string };
  let workflowId = explicit.workflowId;
  if (workflowId === undefined) {
    if (t.idTemplate === undefined) {
      throw new NornConfigError(`Workflow ${t.name} has no ID template; pass { workflowId }`);
    }
    workflowId = formatWorkflowId(t.idTemplate, id);
  }
  const handle = getExternalWorkflowHandle(workflowId, explicit.runId);
  return {
    workflowId,
    signal: (key, ...args) => handle.signal(t.signalName(key), ...(args as unknown[])),
    cancel: () => handle.cancel(),
  };
}
