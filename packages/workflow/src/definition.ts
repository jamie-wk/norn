import {
  NORN,
  NornConfigError,
  SEARCH_ATTRIBUTE_TYPES,
  classTag,
  methodTags,
  templateKeys,
  type SearchAttributeType,
} from '@norn/core';

export type VersioningBehavior = 'pinned' | 'auto-upgrade';
export type UnfinishedPolicy = 'abandon' | 'warn';

export interface WorkflowOptions<Id extends string = string> {
  /** Task queue the workflow runs on. */
  taskQueue: string;
  /** Temporal workflow type name. Defaults to the class name; must be a valid identifier. */
  name?: string;
  /** Workflow ID template, such as `'order-{orderId}'`; placeholders are fields of `run()`'s input. */
  id?: Id;
  /** Worker versioning behavior. Omit to use the worker's default. */
  versioning?: VersioningBehavior;
  /** Custom search attributes this workflow sets, by name and type. */
  searchAttributes?: Readonly<Record<string, SearchAttributeType>>;
  /** Error classes that fail the workflow (or update) instead of retrying the workflow task. */
  failOn?: readonly (abstract new (...args: any[]) => Error)[];
  /** Wait for in-flight signal and update handlers before completing. Defaults to true. */
  drainHandlers?: boolean;
  /** Short description for docs and tooling. */
  description?: string;
}

export interface HandlerOptions {
  name?: string;
  description?: string;
}

export interface SignalOptions<A extends unknown[] = any[]> extends HandlerOptions {
  /** What happens if the workflow completes while this handler is still running. Defaults to `'warn'`. */
  unfinishedPolicy?: UnfinishedPolicy;
  /** Returns a key per event; repeated keys are ignored. For at-least-once sources such as webhooks. */
  dedupeBy?: (...args: A) => string | undefined;
}

export interface UpdateOptions extends HandlerOptions {
  unfinishedPolicy?: UnfinishedPolicy;
}

export interface HandlerTag {
  kind: 'signal' | 'query' | 'update';
  options: SignalOptions & UpdateOptions;
}

export interface ValidatorTag {
  update: string;
}

export interface HandlerDefinition {
  kind: 'signal' | 'query' | 'update';
  /** Method that implements the handler. */
  method: string;
  /** Registered Temporal name. */
  name: string;
  description?: string;
  unfinishedPolicy?: UnfinishedPolicy;
  dedupeBy?: (...args: any[]) => string | undefined;
  /** Validator method for updates. */
  validator?: string;
}

export interface WorkflowDefinition {
  className: string;
  name: string;
  taskQueue: string;
  idTemplate?: string;
  versioning?: VersioningBehavior;
  searchAttributes: Readonly<Record<string, SearchAttributeType>>;
  failOn: readonly (abstract new (...args: any[]) => Error)[];
  drainHandlers: boolean;
  description?: string;
  signals: HandlerDefinition[];
  queries: HandlerDefinition[];
  updates: HandlerDefinition[];
}

export interface WorkflowTag {
  className: string;
  options: WorkflowOptions;
}

export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const VERSIONING: readonly VersioningBehavior[] = ['pinned', 'auto-upgrade'];
const POLICIES: readonly UnfinishedPolicy[] = ['abandon', 'warn'];

export function validateWorkflowOptions(className: string, options: WorkflowOptions): void {
  const where = `@Workflow on ${className}`;
  if (typeof options !== 'object' || options === null) throw new NornConfigError(`${where}: options are required`);
  if (typeof options.taskQueue !== 'string' || options.taskQueue.trim() === '') {
    throw new NornConfigError(`${where}: taskQueue must be a non-empty string`);
  }
  const name = options.name ?? className;
  if (!IDENTIFIER.test(name)) {
    throw new NornConfigError(`${where}: workflow name "${name}" must be a valid identifier`);
  }
  if (options.id !== undefined) {
    try {
      templateKeys(options.id);
    } catch (error) {
      throw new NornConfigError(`${where}: ${(error as Error).message}`, { cause: error });
    }
  }
  if (options.versioning !== undefined && !VERSIONING.includes(options.versioning)) {
    throw new NornConfigError(`${where}: versioning must be one of ${VERSIONING.join(', ')}`);
  }
  for (const [key, type] of Object.entries(options.searchAttributes ?? {})) {
    if (!SEARCH_ATTRIBUTE_TYPES.includes(type)) {
      throw new NornConfigError(`${where}: search attribute ${key} has unknown type "${String(type)}"`);
    }
  }
  for (const errorClass of options.failOn ?? []) {
    if (typeof errorClass !== 'function') throw new NornConfigError(`${where}: failOn must list error classes`);
  }
}

export function validateHandlerOptions(where: string, options: SignalOptions & UpdateOptions): void {
  if (options.name !== undefined && (typeof options.name !== 'string' || options.name === '')) {
    throw new NornConfigError(`${where}: name must be a non-empty string`);
  }
  if (options.unfinishedPolicy !== undefined && !POLICIES.includes(options.unfinishedPolicy)) {
    throw new NornConfigError(`${where}: unfinishedPolicy must be one of ${POLICIES.join(', ')}`);
  }
  if (options.dedupeBy !== undefined && typeof options.dedupeBy !== 'function') {
    throw new NornConfigError(`${where}: dedupeBy must be a function`);
  }
}

export function isWorkflowClass(value: unknown): value is abstract new (...args: any[]) => unknown {
  return typeof value === 'function' && classTag<WorkflowTag>(value, NORN.workflow) !== undefined;
}

const cache = new WeakMap<Function, WorkflowDefinition>();

/** Reads and validates everything Norn knows about a decorated workflow class. */
export function describeWorkflow(cls: Function): WorkflowDefinition {
  const cached = cache.get(cls);
  if (cached) return cached;
  const tag = classTag<WorkflowTag>(cls, NORN.workflow);
  if (!tag) throw new NornConfigError(`${cls.name || 'class'} is not decorated with @Workflow`);
  const { options, className } = tag;
  const name = options.name ?? className;

  const handlers = methodTags<HandlerTag>(cls, NORN.handler);
  const validators = methodTags<ValidatorTag>(cls, NORN.validator);
  const byKind = { signal: [] as HandlerDefinition[], query: [] as HandlerDefinition[], update: [] as HandlerDefinition[] };
  const names = { signal: new Set<string>(), query: new Set<string>(), update: new Set<string>() };

  for (const { method, tag: handler } of handlers) {
    const handlerName = handler.options.name ?? method;
    if (names[handler.kind].has(handlerName)) {
      throw new NornConfigError(`Workflow ${name}: ${handler.kind} name "${handlerName}" is used by more than one method`);
    }
    names[handler.kind].add(handlerName);
    const definition: HandlerDefinition = { kind: handler.kind, method, name: handlerName };
    if (handler.options.description !== undefined) definition.description = handler.options.description;
    if (handler.options.unfinishedPolicy !== undefined) definition.unfinishedPolicy = handler.options.unfinishedPolicy;
    if (handler.options.dedupeBy !== undefined) definition.dedupeBy = handler.options.dedupeBy;
    byKind[handler.kind].push(definition);
  }

  for (const { method, tag: validator } of validators) {
    const target = byKind.update.find((u) => u.method === validator.update);
    if (!target) {
      throw new NornConfigError(
        `Workflow ${name}: @Validate('${validator.update}') on ${method}() does not match an @Update method`,
      );
    }
    if (target.validator) {
      throw new NornConfigError(`Workflow ${name}: update ${validator.update} has more than one validator`);
    }
    target.validator = method;
  }

  const definition: WorkflowDefinition = {
    className,
    name,
    taskQueue: options.taskQueue,
    searchAttributes: Object.freeze({ ...options.searchAttributes }),
    failOn: Object.freeze([...(options.failOn ?? [])]),
    drainHandlers: options.drainHandlers ?? true,
    signals: byKind.signal,
    queries: byKind.query,
    updates: byKind.update,
  };
  if (options.id !== undefined) definition.idTemplate = options.id;
  if (options.versioning !== undefined) definition.versioning = options.versioning;
  if (options.description !== undefined) definition.description = options.description;
  cache.set(cls, definition);
  return definition;
}
