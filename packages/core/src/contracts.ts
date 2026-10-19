import { NornConfigError } from './errors.js';
import { formatWorkflowId, templateKeys, type MissingTemplateKeys, type TemplateKeys } from './id-template.js';

// ---------------------------------------------------------------------------------------------
// Search attributes
// ---------------------------------------------------------------------------------------------

export type SearchAttributeType = 'text' | 'keyword' | 'int' | 'double' | 'bool' | 'datetime' | 'keywordList';
export type SearchAttributeTypes = Readonly<Record<string, SearchAttributeType>>;

export type SearchAttributeValue<T extends SearchAttributeType> = T extends 'text' | 'keyword'
  ? string
  : T extends 'int' | 'double'
    ? number
    : T extends 'bool'
      ? boolean
      : T extends 'datetime'
        ? Date
        : T extends 'keywordList'
          ? string[]
          : never;

export const SEARCH_ATTRIBUTE_TYPES: readonly SearchAttributeType[] = Object.freeze([
  'text',
  'keyword',
  'int',
  'double',
  'bool',
  'datetime',
  'keywordList',
]);

// ---------------------------------------------------------------------------------------------
// Handler references
// ---------------------------------------------------------------------------------------------

export interface SignalRef<Args extends unknown[] = any[]> {
  readonly kind: 'signal';
  readonly name: string;
  /** Phantom type: the signal's arguments. Never set at runtime. */
  readonly __args?: Args;
}

export interface QueryRef<Result = any, Args extends unknown[] = any[]> {
  readonly kind: 'query';
  readonly name: string;
  readonly __args?: Args;
  readonly __result?: Result;
}

export interface UpdateRef<Result = any, Args extends unknown[] = any[]> {
  readonly kind: 'update';
  readonly name: string;
  readonly __args?: Args;
  readonly __result?: Result;
}

export type HandlerRef = SignalRef | QueryRef | UpdateRef;
export type RefArgs<R> = R extends { readonly __args?: infer A } ? Exclude<A, undefined> : never;
export type RefResult<R> = R extends { readonly __result?: infer T } ? Exclude<T, undefined> | Extract<T, undefined> : never;

// ---------------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------------

declare const inputType: unique symbol;
declare const outputType: unique symbol;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type IdParamsFor<Input, Id> = Id extends string
  ? [TemplateKeys<Id>] extends [never]
    ? Record<string, never>
    : Simplify<Pick<NonNullable<Input>, TemplateKeys<Id> & keyof NonNullable<Input>>>
  : never;

export interface WorkflowContract<
  Input = any,
  Output = any,
  Signals extends Record<string, SignalRef> = Record<string, SignalRef>,
  Queries extends Record<string, QueryRef> = Record<string, QueryRef>,
  Updates extends Record<string, UpdateRef> = Record<string, UpdateRef>,
  SA extends SearchAttributeTypes = SearchAttributeTypes,
  Id extends string | undefined = string | undefined,
> {
  readonly kind: 'norn.workflow';
  /** The Temporal workflow type name. */
  readonly name: string;
  readonly taskQueue: string;
  readonly idTemplate: Id;
  readonly signals: Signals;
  readonly queries: Queries;
  readonly updates: Updates;
  readonly searchAttributes: SA;
  /** Builds the workflow ID from the template's fields. Throws when the contract has no template. */
  workflowId(params: IdParamsFor<Input, Id>): string;
  /** Phantom: the run input type. */
  readonly [inputType]: Input;
  /** Phantom: the run output type. */
  readonly [outputType]: Output;
}

export type AnyWorkflowContract = WorkflowContract<any, any, any, any, any, any, any>;
export type ContractInput<C extends AnyWorkflowContract> = C[typeof inputType];
export type ContractOutput<C extends AnyWorkflowContract> = C[typeof outputType];
export type IdParams<C extends AnyWorkflowContract> = Parameters<C['workflowId']>[0];
export type SearchAttributeValues<C extends AnyWorkflowContract> = {
  -readonly [K in keyof C['searchAttributes']]?: SearchAttributeValue<C['searchAttributes'][K]>;
};

export function isWorkflowContract(value: unknown): value is AnyWorkflowContract {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'norn.workflow';
}

// ---------------------------------------------------------------------------------------------
// Manual contracts: defineWorkflow({ ... })
// ---------------------------------------------------------------------------------------------

export interface TypeSpec<T> {
  readonly kind: 'norn.type';
  readonly __type?: T;
}
export interface SignalSpec<Args extends unknown[]> {
  readonly kind: 'signal';
  readonly name: string | undefined;
  readonly __args?: Args;
}
export interface QuerySpec<Result, Args extends unknown[]> {
  readonly kind: 'query';
  readonly name: string | undefined;
  readonly __args?: Args;
  readonly __result?: Result;
}
export interface UpdateSpec<Result, Args extends unknown[]> {
  readonly kind: 'update';
  readonly name: string | undefined;
  readonly __args?: Args;
  readonly __result?: Result;
}

const TYPE_SPEC: TypeSpec<never> = Object.freeze({ kind: 'norn.type' as const });

/** Declares a type for a manual contract's input or output. Has no runtime value. */
export function type<T>(): TypeSpec<T> {
  return TYPE_SPEC as TypeSpec<T>;
}
export function signal<Args extends unknown[] = []>(name?: string): SignalSpec<Args> {
  return Object.freeze({ kind: 'signal' as const, name });
}
export function query<Result, Args extends unknown[] = []>(name?: string): QuerySpec<Result, Args> {
  return Object.freeze({ kind: 'query' as const, name });
}
export function update<Result, Args extends unknown[] = []>(name?: string): UpdateSpec<Result, Args> {
  return Object.freeze({ kind: 'update' as const, name });
}

export interface ManualWorkflowDef {
  name: string;
  taskQueue: string;
  id?: string;
  input?: TypeSpec<any>;
  output?: TypeSpec<any>;
  signals?: Record<string, SignalSpec<any>>;
  queries?: Record<string, QuerySpec<any, any>>;
  updates?: Record<string, UpdateSpec<any, any>>;
  searchAttributes?: Record<string, SearchAttributeType>;
}

type SpecType<S> = S extends TypeSpec<infer T> ? T : undefined;
type ManualInput<D extends ManualWorkflowDef> = SpecType<D['input']>;

type CheckId<Id, Input> = Id extends string
  ? [MissingTemplateKeys<Id, Input>] extends [never]
    ? unknown
    : { id: { error: `ID template field "${MissingTemplateKeys<Id, Input> & string}" is not a field of the workflow input` } }
  : unknown;

type SearchAttributesOf<S> = { -readonly [K in keyof OrEmpty<S>]: OrEmpty<S>[K] extends SearchAttributeType ? OrEmpty<S>[K] : never };

type ManualSignals<S> = { -readonly [K in keyof S]: S[K] extends SignalSpec<infer A> ? SignalRef<A> : never };
type ManualQueries<S> = { -readonly [K in keyof S]: S[K] extends QuerySpec<infer R, infer A> ? QueryRef<R, A> : never };
type ManualUpdates<S> = { -readonly [K in keyof S]: S[K] extends UpdateSpec<infer R, infer A> ? UpdateRef<R, A> : never };
type OrEmpty<T> = [T] extends [undefined] ? {} : NonNullable<T>;

export type ManualContract<D extends ManualWorkflowDef> = WorkflowContract<
  ManualInput<D>,
  SpecType<D['output']>,
  ManualSignals<OrEmpty<D['signals']>>,
  ManualQueries<OrEmpty<D['queries']>>,
  ManualUpdates<OrEmpty<D['updates']>>,
  SearchAttributesOf<D['searchAttributes']>,
  D['id'] extends string ? D['id'] : undefined
>;

/**
 * Defines a workflow contract by hand. Most apps use contracts generated by `norn gen`; manual
 * contracts are for workflows implemented elsewhere, such as in another language or service.
 */
export function defineWorkflow<const D extends ManualWorkflowDef>(
  def: D & CheckId<D['id'], ManualInput<D>>,
): ManualContract<D> {
  return buildContract({
    name: def.name,
    taskQueue: def.taskQueue,
    id: def.id,
    signals: mapNames(def.signals),
    queries: mapNames(def.queries),
    updates: mapNames(def.updates),
    searchAttributes: def.searchAttributes,
  }) as unknown as ManualContract<D>;
}

// ---------------------------------------------------------------------------------------------
// Generated contracts: contract<typeof MyWorkflow>()({ ... })
// ---------------------------------------------------------------------------------------------

export type WorkflowClass = abstract new (...args: any[]) => { run(...args: any[]): Promise<unknown> | unknown };
type Instance<C> = C extends abstract new (...args: any[]) => infer I ? I : never;
type RunMethod<C> = Instance<C> extends { run: infer R } ? R : never;

/** The input of a workflow class: the first parameter of `run()`, or `undefined` when it takes none. */
export type WorkflowInput<C> = RunMethod<C> extends (...args: infer A) => any ? (A extends [] ? undefined : A[0]) : never;
/** The output of a workflow class: the awaited return type of `run()`. */
export type WorkflowOutput<C> = RunMethod<C> extends (...args: any[]) => infer R ? Awaited<R> : never;

export type HandlerMethodKey<C> = Exclude<
  { [K in keyof Instance<C>]: Instance<C>[K] extends (...args: any[]) => any ? K : never }[keyof Instance<C>],
  'run'
> &
  string;

type MethodArgs<C, K> = K extends keyof Instance<C> ? (Instance<C>[K] extends (...args: infer A) => any ? A : never) : never;
type MethodResult<C, K> = K extends keyof Instance<C>
  ? Instance<C>[K] extends (...args: any[]) => infer R
    ? Awaited<R>
    : never
  : never;

export interface GeneratedWorkflowDef<C> {
  name: string;
  taskQueue: string;
  id?: string;
  signals?: Partial<Record<HandlerMethodKey<C>, string>>;
  queries?: Partial<Record<HandlerMethodKey<C>, string>>;
  updates?: Partial<Record<HandlerMethodKey<C>, string>>;
  searchAttributes?: Record<string, SearchAttributeType>;
}

type OnlyMethods<S, Allowed> = S extends object
  ? { [K in Exclude<keyof S, Allowed>]: { error: `"${K & string}" is not a method of the workflow class` } }
  : unknown;

type CheckGenerated<C, D extends GeneratedWorkflowDef<C>> = CheckId<D['id'], WorkflowInput<C>> & {
  signals?: OnlyMethods<D['signals'], HandlerMethodKey<C>>;
  queries?: OnlyMethods<D['queries'], HandlerMethodKey<C>>;
  updates?: OnlyMethods<D['updates'], HandlerMethodKey<C>>;
};

export type GeneratedContract<C, D extends GeneratedWorkflowDef<C>> = WorkflowContract<
  WorkflowInput<C>,
  WorkflowOutput<C>,
  { -readonly [K in keyof OrEmpty<D['signals']>]: SignalRef<MethodArgs<C, K>> },
  { -readonly [K in keyof OrEmpty<D['queries']>]: QueryRef<MethodResult<C, K>, MethodArgs<C, K>> },
  { -readonly [K in keyof OrEmpty<D['updates']>]: UpdateRef<MethodResult<C, K>, MethodArgs<C, K>> },
  SearchAttributesOf<D['searchAttributes']>,
  D['id'] extends string ? D['id'] : undefined
>;

/**
 * Builds a contract whose types come from a workflow class. `norn gen` emits these with
 * `import type`, so API code gets full types without bundling any worker code.
 */
export function contract<C extends WorkflowClass>() {
  return <const D extends GeneratedWorkflowDef<C>>(def: D & CheckGenerated<C, D>): GeneratedContract<C, D> =>
    buildContract({
      name: def.name,
      taskQueue: def.taskQueue,
      id: def.id,
      signals: def.signals as Record<string, string> | undefined,
      queries: def.queries as Record<string, string> | undefined,
      updates: def.updates as Record<string, string> | undefined,
      searchAttributes: def.searchAttributes,
    }) as unknown as GeneratedContract<C, D>;
}

// ---------------------------------------------------------------------------------------------
// Runtime construction shared by both forms
// ---------------------------------------------------------------------------------------------

function mapNames(specs: Record<string, { name: string | undefined }> | undefined): Record<string, string> | undefined {
  if (!specs) return undefined;
  return Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, spec.name ?? key]));
}

interface ContractParts {
  name: string;
  taskQueue: string;
  id: string | undefined;
  signals: Record<string, string> | undefined;
  queries: Record<string, string> | undefined;
  updates: Record<string, string> | undefined;
  searchAttributes: Record<string, SearchAttributeType> | undefined;
}

function refs(kind: 'signal' | 'query' | 'update', names: Record<string, string> | undefined, workflow: string) {
  const out: Record<string, HandlerRef> = {};
  const seen = new Set<string>();
  for (const [key, name] of Object.entries(names ?? {})) {
    if (typeof name !== 'string' || name === '') {
      throw new NornConfigError(`Workflow ${workflow}: ${kind} "${key}" needs a non-empty name`);
    }
    if (seen.has(name)) {
      throw new NornConfigError(`Workflow ${workflow}: ${kind} name "${name}" is used more than once`);
    }
    seen.add(name);
    out[key] = Object.freeze({ kind, name }) as HandlerRef;
  }
  return Object.freeze(out);
}

function buildContract(parts: ContractParts): AnyWorkflowContract {
  const { name, taskQueue, id } = parts;
  if (typeof name !== 'string' || name.trim() === '') throw new NornConfigError('A workflow contract needs a name');
  if (typeof taskQueue !== 'string' || taskQueue.trim() === '') {
    throw new NornConfigError(`Workflow ${name}: taskQueue must be a non-empty string`);
  }
  if (id !== undefined) templateKeys(id);
  const searchAttributes = { ...parts.searchAttributes };
  for (const [key, saType] of Object.entries(searchAttributes)) {
    if (!SEARCH_ATTRIBUTE_TYPES.includes(saType)) {
      throw new NornConfigError(
        `Workflow ${name}: search attribute ${key} has unknown type "${String(saType)}"; use one of ${SEARCH_ATTRIBUTE_TYPES.join(', ')}`,
      );
    }
  }
  const contractObject = {
    kind: 'norn.workflow' as const,
    name,
    taskQueue,
    idTemplate: id,
    signals: refs('signal', parts.signals, name),
    queries: refs('query', parts.queries, name),
    updates: refs('update', parts.updates, name),
    searchAttributes: Object.freeze(searchAttributes),
    workflowId(params: unknown): string {
      if (id === undefined) {
        throw new NornConfigError(`Workflow ${name} has no ID template; pass an explicit workflowId`);
      }
      return formatWorkflowId(id, params);
    },
  };
  return Object.freeze(contractObject) as unknown as AnyWorkflowContract;
}
