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
 * Continues the current workflow as a new run with `input`, after in-flight handlers finish so no
 * signal or update is lost in the rollover.
 */
export async function continueAsNew<Input>(input: Input, options: ContinueAsNewOptions = {}): Promise<never> {
  if (options.waitForHandlers !== false) await condition(allHandlersFinished);
  return temporalContinueAsNew<(input: Input) => Promise<unknown>>(input);
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

export type SearchAttributeInput = string | number | boolean | Date | string[] | null;

/**
 * Sets custom search attributes declared in `@Workflow({ searchAttributes })`. Pass `null` to
 * clear one. Unknown names are rejected so typos fail loudly.
 */
export function setSearchAttributes(values: Record<string, SearchAttributeInput>): void {
  const type = workflowInfo().workflowType;
  const def = definitionFor(type);
  if (!def) throw new NornConfigError(`setSearchAttributes(): workflow ${type} was not registered with implement()`);
  const pairs = Object.entries(values).map(([name, value]) => {
    const saType = def.searchAttributes[name];
    if (!saType) {
      throw new NornConfigError(`Workflow ${type} does not declare search attribute ${name} in @Workflow({ searchAttributes })`);
    }
    return { key: defineSearchAttributeKey(name, TEMPORAL_SA[saType]), value };
  });
  upsertSearchAttributes(pairs as Parameters<typeof upsertSearchAttributes>[0]);
}
