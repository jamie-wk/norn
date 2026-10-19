import {
  allHandlersFinished,
  condition,
  continueAsNew as temporalContinueAsNew,
  upsertSearchAttributes,
  workflowInfo,
} from '@temporalio/workflow';
import { ApplicationFailure, defineSearchAttributeKey, type SearchAttributeType as TemporalSAType } from '@temporalio/common';
import { NornConfigError, type SearchAttributeType } from '@norn/core';
import { definitionFor } from './implement.js';

export interface ContinueAsNewOptions {
  /** Wait for in-flight signal and update handlers first. Defaults to true. */
  waitForHandlers?: boolean;
}

/**
 * Continues the current workflow as a new run, after in-flight handlers finish so no signal or
 * update is lost in the rollover. Pass the input as a function, `continueAsNew(() => ({ count: this.count }))`,
 * so it is read after those handlers ran; a plain value is captured before they finish.
 */
export async function continueAsNew<Input>(input: Input | (() => Input), options: ContinueAsNewOptions = {}): Promise<never> {
  if (options.waitForHandlers !== false) await condition(allHandlersFinished);
  // Workflow inputs are serializable data, never functions, so a function can only be the thunk.
  const next = typeof input === 'function' ? (input as () => Input)() : input;
  return temporalContinueAsNew<(input: Input) => Promise<unknown>>(next);
}

/** True when Temporal suggests continuing as new because history is getting large. */
export function continueAsNewSuggested(): boolean {
  return workflowInfo().continueAsNewSuggested;
}

type ErrorType = string | (abstract new (...args: any[]) => Error);

/**
 * Finds the `ApplicationFailure` of the given type in an error's cause chain, such as an activity
 * failure caused by `PaymentRejectedError`. Matches the error class name, or a custom `name`.
 */
export function asFailure(error: unknown, type: ErrorType): ApplicationFailure | undefined {
  const name = typeof type === 'string' ? type : type.name;
  let current: unknown = error;
  for (let depth = 0; current && depth < 16; depth++) {
    if (current instanceof ApplicationFailure && current.type === name) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Whether an error was caused by a failure of the given type. See {@link asFailure}. */
export function isFailure(error: unknown, type: ErrorType): boolean {
  return asFailure(error, type) !== undefined;
}

const TEMPORAL_SA: Record<SearchAttributeType, TemporalSAType> = {
  text: 'TEXT',
  keyword: 'KEYWORD',
  int: 'INT',
  double: 'DOUBLE',
  bool: 'BOOL',
  datetime: 'DATETIME',
  keywordList: 'KEYWORD_LIST',
};

const VALID: Record<SearchAttributeType, (value: unknown) => boolean> = {
  text: (v) => typeof v === 'string',
  keyword: (v) => typeof v === 'string',
  int: Number.isInteger,
  double: Number.isFinite,
  bool: (v) => typeof v === 'boolean',
  datetime: (v) => v instanceof Date && !Number.isNaN(v.getTime()),
  keywordList: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
};

export type SearchAttributeInput = string | number | boolean | Date | string[] | null;

/**
 * Sets custom search attributes declared in `@Workflow({ searchAttributes })`. Pass `null` to
 * clear one. Unknown names and values of the wrong type are rejected so mistakes fail loudly.
 */
export function setSearchAttributes(values: Record<string, SearchAttributeInput>): void {
  const type = workflowInfo().workflowType;
  const def = definitionFor(type);
  if (!def) throw new NornConfigError(`setSearchAttributes(): workflow ${type} was not registered with implement()`);
  const pairs = Object.entries(values).map(([name, value]) => {
    if (!Object.hasOwn(def.searchAttributes, name)) {
      throw new NornConfigError(`Workflow ${type} does not declare search attribute ${name} in @Workflow({ searchAttributes })`);
    }
    const saType = def.searchAttributes[name]!;
    if (value !== null && !VALID[saType](value)) {
      throw new NornConfigError(`Workflow ${type}: search attribute ${name} is ${saType}, got ${JSON.stringify(value)}`);
    }
    return { key: defineSearchAttributeKey(name, TEMPORAL_SA[saType]), value };
  });
  upsertSearchAttributes(pairs as Parameters<typeof upsertSearchAttributes>[0]);
}
