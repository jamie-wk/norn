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
  type Duration,
  type WorkflowClass,
  type WorkflowInput,
  type WorkflowOutput,
} from '../core/index.js';
import { describeWorkflow, type WorkflowDefinition } from './definition.js';

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

type InstanceOf<T> = T extends abstract new (...args: any[]) => infer I ? I : never;
type MethodKey<T> = { [K in keyof InstanceOf<T>]: InstanceOf<T>[K] extends (...args: any[]) => any ? K : never }[keyof InstanceOf<T>] &
  string;

/** Handler methods of a workflow class (the kind is checked at runtime). */
type SignalKey<T> = Exclude<MethodKey<T>, 'run'>;
type SignalArgs<T, K> = K extends keyof InstanceOf<T> ? (InstanceOf<T>[K] extends (...args: infer A) => any ? A : never) : never;

type AsArgs<X> = X extends any[] ? X : never;

type StartArgs<T> = WorkflowInput<T> extends undefined
  ? [input?: WorkflowInput<T>, options?: ChildOptions]
  : [input: WorkflowInput<T>, options?: ChildOptions];

export interface ChildHandle<T> {
  readonly workflowId: string;
  readonly firstExecutionRunId: string;
  result(): Promise<WorkflowOutput<T>>;
  signal<K extends SignalKey<T>>(signal: K, ...args: AsArgs<SignalArgs<T, K>>): Promise<void>;
}

export interface ChildRef<T> {
  /** Starts the child and returns a handle once it is running. */
  start(...args: StartArgs<T>): Promise<ChildHandle<T>>;
  /** Starts the child and waits for its result. */
  execute(...args: StartArgs<T>): Promise<WorkflowOutput<T>>;
}

export interface ExternalRef<T> {
  readonly workflowId: string;
  signal<K extends SignalKey<T>>(signal: K, ...args: AsArgs<SignalArgs<T, K>>): Promise<void>;
  cancel(): Promise<void>;
}

function signalName(def: WorkflowDefinition, key: string): string {
  const handler = def.signals.find((s) => s.method === key);
  if (!handler) throw new NornConfigError(`Workflow ${def.name} has no @Signal method "${key}"`);
  return handler.name;
}

const CLOSE_POLICY = {
  terminate: ParentClosePolicy.TERMINATE,
  abandon: ParentClosePolicy.ABANDON,
  'request-cancel': ParentClosePolicy.REQUEST_CANCEL,
} as const;

function wrapHandle<T>(handle: ChildWorkflowHandle<any>, def: WorkflowDefinition): ChildHandle<T> {
  return {
    workflowId: handle.workflowId,
    firstExecutionRunId: handle.firstExecutionRunId,
    result: () => handle.result() as Promise<WorkflowOutput<T>>,
    signal: (key, ...args) => handle.signal(signalName(def, key), ...(args as unknown[])),
  };
}

/** Returns a typed reference for starting a child workflow from its `@Workflow` class. */
export function useChild<T extends WorkflowClass>(target: T, defaults: ChildOptions = {}): ChildRef<T> {
  const t = describeWorkflow(target);
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
export function useExternal<T extends WorkflowClass>(
  target: T,
  id: Partial<NonNullable<WorkflowInput<T>>> | { workflowId: string; runId?: string },
): ExternalRef<T> {
  const t = describeWorkflow(target);
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
    signal: (key, ...args) => handle.signal(signalName(t, key), ...(args as unknown[])),
    cancel: () => handle.cancel(),
  };
}
