import {
  NORN,
  NornConfigError,
  setClassTag,
  classTag,
  tagMethod,
  type MissingTemplateKeys,
  type ScheduleOverlap,
  type WorkflowClass,
  type WorkflowInput,
} from '@norn-ts/core';
import {
  validateHandlerOptions,
  validateWorkflowOptions,
  type HandlerOptions,
  type HandlerTag,
  type SignalOptions,
  type UpdateOptions,
  type ValidatorTag,
  type WorkflowOptions,
  type WorkflowTag,
} from './definition.js';

type IdTemplateCheck<Id, Input> = Id extends string
  ? [MissingTemplateKeys<Id, Input>] extends [never]
    ? void
    : { error: `ID template field "${MissingTemplateKeys<Id, Input> & string}" is not a field of run()'s input` }
  : void;

function isAsync(fn: Function): boolean {
  const name = fn.constructor?.name;
  return name === 'AsyncFunction' || name === 'AsyncGeneratorFunction';
}

function checkMethodContext(decorator: string, context: ClassMethodDecoratorContext): void {
  if (context.kind !== 'method') throw new NornConfigError(`${decorator} can only decorate methods`);
  if (context.private) throw new NornConfigError(`${decorator} cannot decorate private method ${String(context.name)}`);
  if (context.static) throw new NornConfigError(`${decorator} cannot decorate static method ${String(context.name)}`);
  if (typeof context.name !== 'string') throw new NornConfigError(`${decorator} cannot decorate symbol-named methods`);
}

/**
 * Marks a class as a Temporal workflow. The class needs an async `run(input)` method; its
 * constructor receives the same input before any signal, query or update handler runs.
 *
 * ```ts
 * @Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
 * export class OrderWorkflow {
 *   async run(input: { orderId: string }) { ... }
 * }
 * ```
 */
export function Workflow<const O extends WorkflowOptions>(options: O) {
  return <C extends WorkflowClass>(target: C, context: ClassDecoratorContext<C>): IdTemplateCheck<O['id'], WorkflowInput<C>> => {
    const className = String(context.name ?? target.name);
    if (classTag(target, NORN.workflow)) {
      throw new NornConfigError(`${className} is already decorated with @Workflow`);
    }
    if (typeof (target as unknown as { prototype?: { run?: unknown } }).prototype?.run !== 'function') {
      throw new NornConfigError(`@Workflow on ${className}: the class needs a run() method`);
    }
    validateWorkflowOptions(className, options);
    const tag: WorkflowTag = { className, options: { ...options } };
    setClassTag(target, NORN.workflow, tag);
    return undefined as IdTemplateCheck<O['id'], WorkflowInput<C>>;
  };
}

function handlerDecorator(kind: HandlerTag['kind'], decorator: string, raw?: string | (SignalOptions & UpdateOptions)) {
  const options: SignalOptions & UpdateOptions = typeof raw === 'string' ? { name: raw } : { ...raw };
  validateHandlerOptions(decorator, options);
  return (fn: Function, context: ClassMethodDecoratorContext) => {
    checkMethodContext(decorator, context);
    if (kind === 'query' && isAsync(fn)) {
      throw new NornConfigError(`@Query ${String(context.name)}() must be synchronous; queries cannot await`);
    }
    tagMethod(fn, NORN.handler, { kind, options } satisfies HandlerTag);
  };
}

/** Registers a method as a signal handler. Signals are fire-and-forget messages. */
export function Signal<A extends unknown[] = any[]>(options?: string | SignalOptions<A>) {
  const decorate = handlerDecorator('signal', '@Signal', options as SignalOptions);
  return <This>(fn: (this: This, ...args: A) => unknown, context: ClassMethodDecoratorContext<This>): void =>
    decorate(fn, context as ClassMethodDecoratorContext);
}

/** Registers a synchronous, read-only method as a query handler. */
export function Query(options?: string | HandlerOptions) {
  const decorate = handlerDecorator('query', '@Query', options);
  return <This, R>(
    fn: (this: This, ...args: any[]) => R,
    context: ClassMethodDecoratorContext<This>,
  ): R extends PromiseLike<unknown> ? { error: 'Query handlers must be synchronous' } : void => {
    decorate(fn, context as ClassMethodDecoratorContext);
    return undefined as R extends PromiseLike<unknown> ? { error: 'Query handlers must be synchronous' } : void;
  };
}

/** Registers a method as an update handler: a tracked request that returns a result. */
export function Update(options?: string | UpdateOptions) {
  const decorate = handlerDecorator('update', '@Update', options);
  return <This>(fn: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): void =>
    decorate(fn, context as ClassMethodDecoratorContext);
}

/**
 * Registers a validator for the update method `update`. Validators run before the update is
 * accepted; throwing rejects it without writing to history. They must be synchronous.
 */
export function Validate<const N extends string>(update: N) {
  if (typeof update !== 'string' || update === '') throw new NornConfigError('@Validate needs an update method name');
  return <This extends { [K in N]: (...args: any[]) => unknown }>(
    fn: (this: This, ...args: Parameters<This[N]>) => void,
    context: ClassMethodDecoratorContext<This>,
  ): void => {
    checkMethodContext('@Validate', context as ClassMethodDecoratorContext);
    if (isAsync(fn)) throw new NornConfigError(`@Validate ${String(context.name)}() must be synchronous`);
    tagMethod(fn, NORN.validator, { update } satisfies ValidatorTag);
  };
}

export interface ScheduleOptions<Input = unknown> {
  /** Schedule ID. Defaults to the workflow name in kebab case. */
  id?: string;
  /** Input passed to every run. Must be JSON. */
  input?: Input;
  /** What to do when a run is still going at the next fire time. Defaults to `'skip'`. */
  overlap?: ScheduleOverlap;
  /** Time zone for the cron expression, such as `'America/New_York'`. Defaults to UTC. */
  timeZone?: string;
  /** Pause the schedule after a failed run. */
  pauseOnFailure?: boolean;
  /** Create the schedule paused. */
  paused?: boolean;
  /** Human-readable note shown in the Temporal UI. */
  note?: string;
}

/**
 * Declares a schedule for a workflow. `norn gen` reads it from the source and `norn schedules sync`
 * creates, updates or removes the matching Temporal schedules. It does nothing at runtime; its
 * types check `input` against `run()`.
 */
export function Schedule<C extends WorkflowClass>(_cron: string | string[], _options?: ScheduleOptions<WorkflowInput<C>>) {
  return (_target: C, _context: ClassDecoratorContext<C>): void => {};
}
