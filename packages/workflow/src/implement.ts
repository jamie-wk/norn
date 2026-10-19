import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  setHandler,
  setWorkflowOptions,
} from '@temporalio/workflow';
import { NORN, type WorkflowClass, type WorkflowInput, type WorkflowOutput } from '@norn/core';
import { describeWorkflow, type HandlerDefinition, type UnfinishedPolicy, type WorkflowDefinition } from './definition.js';

export interface ImplementOptions {
  /** Handler descriptions keyed by method name, usually generated from JSDoc by `norn gen`. */
  descriptions?: Readonly<Record<string, string>>;
}

export type RunArgs<C> = WorkflowInput<C> extends undefined ? [input?: WorkflowInput<C>] : [input: WorkflowInput<C>];

/** The Temporal workflow function produced by {@link implement}. */
export type WorkflowFunction<C> = ((...args: RunArgs<C>) => Promise<WorkflowOutput<C>>) & {
  readonly workflowType: string;
};

const definitions = new Map<string, WorkflowDefinition>();

/** The definition registered for a workflow type in this bundle, if any. */
export function definitionFor(workflowType: string): WorkflowDefinition | undefined {
  return definitions.get(workflowType);
}

const POLICY = { abandon: 'ABANDON', warn: 'WARN_AND_ABANDON' } as const satisfies Record<UnfinishedPolicy, string>;

function handlerOptions(handler: HandlerDefinition, descriptions: Readonly<Record<string, string>> | undefined) {
  const options: { description?: string; unfinishedPolicy?: 'ABANDON' | 'WARN_AND_ABANDON' } = {};
  const description = handler.description ?? descriptions?.[handler.method];
  if (description !== undefined) options.description = description;
  if (handler.unfinishedPolicy !== undefined) options.unfinishedPolicy = POLICY[handler.unfinishedPolicy];
  return options;
}

type Instance = Record<string, (...args: unknown[]) => unknown> & { run(input: unknown): Promise<unknown> };

function registerHandlers(def: WorkflowDefinition, instance: Instance, descriptions?: Readonly<Record<string, string>>) {
  for (const signal of def.signals) {
    const dedupeBy = signal.dedupeBy;
    const seen = dedupeBy ? new Set<string>() : undefined;
    setHandler(
      defineSignal<unknown[]>(signal.name),
      (...args: unknown[]) => {
        if (dedupeBy && seen) {
          const key = dedupeBy(...args);
          if (key !== undefined) {
            if (seen.has(key)) return;
            seen.add(key);
          }
        }
        return instance[signal.method]!(...args) as void | Promise<void>;
      },
      handlerOptions(signal, descriptions),
    );
  }
  for (const query of def.queries) {
    setHandler(
      defineQuery<unknown, unknown[]>(query.name),
      (...args: unknown[]) => instance[query.method]!(...args),
      handlerOptions(query, descriptions),
    );
  }
  for (const update of def.updates) {
    const validatorMethod = update.validator;
    setHandler(
      defineUpdate<unknown, unknown[]>(update.name),
      (...args: unknown[]) => instance[update.method]!(...args),
      {
        ...handlerOptions(update, descriptions),
        ...(validatorMethod
          ? {
              validator: (...args: unknown[]) => {
                instance[validatorMethod]!(...args);
              },
            }
          : {}),
      },
    );
  }
}

/**
 * Turns a `@Workflow` class into the workflow function Temporal runs. `norn gen` writes these
 * calls into the generated workflows file; you rarely call it yourself.
 *
 * Each run constructs the class with the input, registers every handler before any of them can
 * fire, runs `run(input)`, and by default waits for in-flight handlers before completing.
 */
export function implement<C extends WorkflowClass>(cls: C, options: ImplementOptions = {}): WorkflowFunction<C> {
  const def = describeWorkflow(cls);
  definitions.set(def.name, def);
  const Ctor = cls as unknown as new (input: unknown) => Instance;

  const workflow = async function (input?: unknown): Promise<unknown> {
    const instance = new Ctor(input);
    registerHandlers(def, instance, options.descriptions);
    const result = await instance.run(input);
    if (def.drainHandlers) await condition(allHandlersFinished);
    return result;
  };
  Object.defineProperty(workflow, 'name', { value: def.name });
  Object.defineProperty(workflow, 'workflowType', { value: def.name, enumerable: true });
  Object.defineProperty(workflow, NORN.workflow, { value: def });

  if (def.versioning !== undefined || def.failOn.length > 0) {
    setWorkflowOptions(
      {
        ...(def.versioning !== undefined ? { versioningBehavior: def.versioning === 'pinned' ? 'PINNED' : 'AUTO_UPGRADE' } : {}),
        ...(def.failOn.length > 0 ? { failureExceptionTypes: [...def.failOn] as (new (...args: any[]) => Error)[] } : {}),
      },
      workflow,
    );
  }
  return workflow as unknown as WorkflowFunction<C>;
}
