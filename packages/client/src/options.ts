import { defineSearchAttributeKey, type SearchAttributePair, type Priority, type RetryPolicy } from '@temporalio/common';
import {
  NornConfigError,
  TEMPORAL_SEARCH_ATTRIBUTE_TYPES,
  formatDuration,
  isSearchAttributeValue,
  type AnyWorkflowContract,
  type Duration,
  type SearchAttributeType,
  type SearchAttributeValues,
} from '@norn-ts/core';

export type IfRunning = 'fail' | 'useExisting' | 'terminateExisting';
export type IfClosed = 'allow' | 'allowIfFailed' | 'reject';

export interface StartOptions<C extends AnyWorkflowContract = AnyWorkflowContract> {
  /** Overrides the ID built from the contract's template. Required when the contract has none. */
  workflowId?: string;
  /** Overrides the contract's task queue. */
  taskQueue?: string;
  /** What to do when a workflow with this ID is running. Default `'fail'` (409). */
  ifRunning?: IfRunning;
  /** Whether a closed workflow's ID may be reused. Default `'allow'`. */
  ifClosed?: IfClosed;
  /** Initial search attributes, typed from the contract. */
  searchAttributes?: SearchAttributeValues<C>;
  memo?: Record<string, unknown>;
  executionTimeout?: Duration;
  runTimeout?: Duration;
  taskTimeout?: Duration;
  startDelay?: Duration;
  /** A short summary shown in the Temporal UI. */
  summary?: string;
  /** Longer details shown in the Temporal UI. */
  details?: string;
  retry?: RetryPolicy;
  priority?: Priority;
  /** Correlation ID for this call; defaults to the one set with `runWithCorrelationId()`. */
  correlationId?: string;
}

const CONFLICT: Record<IfRunning, 'FAIL' | 'USE_EXISTING' | 'TERMINATE_EXISTING'> = {
  fail: 'FAIL',
  useExisting: 'USE_EXISTING',
  terminateExisting: 'TERMINATE_EXISTING',
};
const REUSE: Record<IfClosed, 'ALLOW_DUPLICATE' | 'ALLOW_DUPLICATE_FAILED_ONLY' | 'REJECT_DUPLICATE'> = {
  allow: 'ALLOW_DUPLICATE',
  allowIfFailed: 'ALLOW_DUPLICATE_FAILED_ONLY',
  reject: 'REJECT_DUPLICATE',
};

function checkValue(name: string, type: SearchAttributeType, value: unknown): void {
  if (!isSearchAttributeValue(type, value)) throw new NornConfigError(`Search attribute ${name} is declared as ${type} but got ${JSON.stringify(value)}`);
}

/** Converts `{ Name: value }` into Temporal's typed search attribute pairs, checked against the contract. */
export function toTypedSearchAttributes<C extends AnyWorkflowContract>(contract: C, values: SearchAttributeValues<C>): SearchAttributePair[] {
  const pairs: SearchAttributePair[] = [];
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (value === undefined) continue;
    const type = contract.searchAttributes[name] as SearchAttributeType | undefined;
    if (!type) throw new NornConfigError(`Workflow ${contract.name} does not declare search attribute ${name}`);
    checkValue(name, type, value);
    pairs.push({ key: defineSearchAttributeKey(name, TEMPORAL_SEARCH_ATTRIBUTE_TYPES[type]), value } as SearchAttributePair);
  }
  return pairs;
}

function duration(field: string, value: Duration | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return formatDuration(value);
  } catch (error) {
    throw new NornConfigError(`${field}: ${(error as Error).message}`, { cause: error });
  }
}

export function resolveWorkflowId(contract: AnyWorkflowContract, input: unknown, explicit?: string): string {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit === '') throw new NornConfigError('workflowId must be a non-empty string');
    return explicit;
  }
  if (contract.idTemplate === undefined) {
    throw new NornConfigError(`Workflow ${contract.name} has no ID template; pass { workflowId }`);
  }
  return contract.workflowId(input as never);
}

/** Builds Temporal start options from a contract, its input and Norn start options. */
export function startOptions<C extends AnyWorkflowContract>(contract: C, input: unknown, options: StartOptions<C> = {}) {
  if (options.ifRunning !== undefined && !Object.hasOwn(CONFLICT, options.ifRunning)) {
    throw new NornConfigError(`ifRunning must be one of ${Object.keys(CONFLICT).join(', ')}`);
  }
  if (options.ifClosed !== undefined && !Object.hasOwn(REUSE, options.ifClosed)) {
    throw new NornConfigError(`ifClosed must be one of ${Object.keys(REUSE).join(', ')}`);
  }
  const typed = options.searchAttributes ? toTypedSearchAttributes(contract, options.searchAttributes) : undefined;
  const result = {
    workflowId: resolveWorkflowId(contract, input, options.workflowId),
    taskQueue: options.taskQueue ?? contract.taskQueue,
    args: input === undefined ? [] : [input],
    workflowIdConflictPolicy: options.ifRunning ? CONFLICT[options.ifRunning] : undefined,
    workflowIdReusePolicy: options.ifClosed ? REUSE[options.ifClosed] : undefined,
    typedSearchAttributes: typed?.length ? typed : undefined,
    memo: options.memo,
    workflowExecutionTimeout: duration('executionTimeout', options.executionTimeout),
    workflowRunTimeout: duration('runTimeout', options.runTimeout),
    workflowTaskTimeout: duration('taskTimeout', options.taskTimeout),
    startDelay: duration('startDelay', options.startDelay),
    staticSummary: options.summary,
    staticDetails: options.details,
    retry: options.retry,
    priority: options.priority,
  };
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined)) as typeof result & {
    workflowId: string;
    taskQueue: string;
    args: unknown[];
  };
}
