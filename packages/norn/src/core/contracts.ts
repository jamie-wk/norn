
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

/** Temporal's name for each search attribute type, as `defineSearchAttributeKey()` takes it. */
export const TEMPORAL_SEARCH_ATTRIBUTE_TYPES = Object.freeze({
  text: 'TEXT',
  keyword: 'KEYWORD',
  int: 'INT',
  double: 'DOUBLE',
  bool: 'BOOL',
  datetime: 'DATETIME',
  keywordList: 'KEYWORD_LIST',
} as const satisfies Record<SearchAttributeType, string>);

export const SEARCH_ATTRIBUTE_TYPES = Object.freeze(Object.keys(TEMPORAL_SEARCH_ATTRIBUTE_TYPES)) as readonly SearchAttributeType[];

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

export type RefArgs<R> = R extends { readonly __args?: infer A } ? Exclude<A, undefined> : never;
export type RefResult<R> = R extends { readonly __result?: infer T } ? Exclude<T, undefined> | Extract<T, undefined> : never;

// ---------------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------------

declare const inputType: unique symbol;
declare const outputType: unique symbol;

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
  workflowId(params: unknown): string;
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

// ---------------------------------------------------------------------------------------------
// Class contracts: a @Workflow class is its own contract
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

/**
 * The contract of a decorated workflow class, read from its decorators at runtime. Types come from
 * the class, so every handler method is offered for signal, query and update; using one as the
 * wrong kind fails at runtime.
 */
export type ClassContract<C extends WorkflowClass> = Omit<
  WorkflowContract<
    WorkflowInput<C>,
    WorkflowOutput<C>,
    { [K in HandlerMethodKey<C>]: SignalRef<MethodArgs<C, K>> },
    { [K in HandlerMethodKey<C>]: QueryRef<MethodResult<C, K>, MethodArgs<C, K>> },
    { [K in HandlerMethodKey<C>]: UpdateRef<MethodResult<C, K>, MethodArgs<C, K>> },
    SearchAttributeTypes,
    string
  >,
  'workflowId'
> & {
  /** Builds the workflow ID from the template's fields (checked at runtime). */
  workflowId(params: Partial<NonNullable<WorkflowInput<C>>>): string;
};
