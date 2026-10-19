import {
  NORN,
  NornConfigError,
  classTag,
  errorTypeOf,
  methodTags,
  readMethodTag,
  setClassTag,
  tagMethod,
  toActivityOptions,
  type ActivityOptions,
} from '@norn-ts/core';
import { isInjectionKey, type InjectionKey } from './tokens.js';

export type Scope = 'singleton' | 'activity';
export type ErrorClass = abstract new (...args: any[]) => Error;

export interface ActivitiesOptions {
  /** Prefix for every activity name in the class, such as `'payments.'`. Defaults to none. */
  prefix?: string;
  /** Explicit constructor dependencies, in parameter order. Overrides what `norn gen` infers. */
  inject?: readonly InjectionKey[];
}

export interface ServiceOptions {
  /** The token this class is registered under. Defaults to the class itself. */
  provides?: InjectionKey;
  /** `'singleton'` (default) or `'activity'` for a new instance per activity execution. */
  scope?: Scope;
  /** Explicit constructor dependencies, in parameter order. Overrides what `norn gen` infers. */
  inject?: readonly InjectionKey[];
}

interface ActivitiesTag {
  className: string;
  options: ActivitiesOptions;
}
interface ServiceTag {
  className: string;
  options: ServiceOptions;
}
type NonRetryableTag = readonly ErrorClass[] | true;

export interface ActivityMethodDefinition {
  method: string;
  /** Full registered name, including the class prefix. */
  name: string;
  /** Options recorded in the generated registry, with non-retryable error names merged in. */
  options: ActivityOptions;
  /** Error classes that fail without retry, `true` for every error, or undefined. */
  nonRetryable: NonRetryableTag | undefined;
}

export interface ActivitiesDefinition {
  className: string;
  prefix: string;
  inject: readonly InjectionKey[] | undefined;
  methods: ActivityMethodDefinition[];
}

export interface ServiceDefinition {
  className: string;
  provides: InjectionKey;
  scope: Scope;
  inject: readonly InjectionKey[] | undefined;
}

function checkInject(where: string, inject: readonly unknown[] | undefined): void {
  if (inject === undefined) return;
  if (!Array.isArray(inject) || inject.some((k) => !isInjectionKey(k))) {
    throw new NornConfigError(`${where}: inject must list classes or tokens`);
  }
}

function checkMethod(decorator: string, context: ClassMethodDecoratorContext): void {
  if (context.private) throw new NornConfigError(`${decorator} cannot decorate private method ${String(context.name)}`);
  if (context.static) throw new NornConfigError(`${decorator} cannot decorate static method ${String(context.name)}`);
  if (typeof context.name !== 'string') throw new NornConfigError(`${decorator} cannot decorate symbol-named methods`);
}

/** Marks a class whose `@Activity` methods are registered with the worker. */
export function Activities(options: ActivitiesOptions = {}) {
  if (options.prefix !== undefined && typeof options.prefix !== 'string') {
    throw new NornConfigError('@Activities: prefix must be a string');
  }
  checkInject('@Activities', options.inject);
  return (target: abstract new (...args: any[]) => unknown, context: ClassDecoratorContext): void => {
    const className = String(context.name ?? target.name);
    if (classTag(target, NORN.activities)) throw new NornConfigError(`${className} is already decorated with @Activities`);
    setClassTag(target, NORN.activities, { className, options: { ...options } } satisfies ActivitiesTag);
  };
}

/** Registers a method as an activity. Options travel to workflows through the generated registry. */
export function Activity(options: ActivityOptions = {}) {
  if (options.name !== undefined && (typeof options.name !== 'string' || options.name === '')) {
    throw new NornConfigError('@Activity: name must be a non-empty string');
  }
  // Validate durations and retry settings at definition time.
  toActivityOptions(options);
  return <This>(fn: (this: This, ...args: any[]) => unknown, context: ClassMethodDecoratorContext<This>): void => {
    checkMethod('@Activity', context as ClassMethodDecoratorContext);
    tagMethod(fn, NORN.activity, { ...options });
  };
}

/**
 * Makes errors fail the activity without retries. With no argument every error is final; with a
 * list, only those error classes are. Applies to one method, or to every method of a class.
 */
export function NonRetryable(errors?: readonly ErrorClass[]) {
  if (errors !== undefined && (!Array.isArray(errors) || errors.some((e) => typeof e !== 'function'))) {
    throw new NornConfigError('@NonRetryable: pass error classes, such as [InvalidCardError]');
  }
  const tag: NonRetryableTag = errors ? Object.freeze([...errors]) : true;
  return (target: Function, context: ClassMethodDecoratorContext | ClassDecoratorContext): void => {
    if (context.kind === 'class') {
      setClassTag(target, NORN.nonRetryable, tag);
      return;
    }
    checkMethod('@NonRetryable', context);
    tagMethod(target, NORN.nonRetryable, tag);
  };
}

/** Registers a class with the dependency container, optionally under an interface token. */
export function Service(options: ServiceOptions = {}) {
  if (options.scope !== undefined && options.scope !== 'singleton' && options.scope !== 'activity') {
    throw new NornConfigError(`@Service: scope must be 'singleton' or 'activity'`);
  }
  if (options.provides !== undefined && !isInjectionKey(options.provides)) {
    throw new NornConfigError('@Service: provides must be a class or token');
  }
  checkInject('@Service', options.inject);
  return (target: abstract new (...args: any[]) => unknown, context: ClassDecoratorContext): void => {
    const className = String(context.name ?? target.name);
    if (classTag(target, NORN.service)) throw new NornConfigError(`${className} is already decorated with @Service`);
    setClassTag(target, NORN.service, { className, options: { ...options } } satisfies ServiceTag);
  };
}

function nonRetryableNames(tag: NonRetryableTag | undefined): string[] | undefined {
  if (!tag || tag === true) return undefined;
  return tag.map((cls) => cls.name || errorTypeOf(Object.create(cls.prototype)));
}

/** Reads and validates an `@Activities` class. */
export function describeActivities(cls: Function): ActivitiesDefinition {
  const tag = classTag<ActivitiesTag>(cls, NORN.activities);
  if (!tag) throw new NornConfigError(`${cls.name || 'class'} is not decorated with @Activities`);
  const prefix = tag.options.prefix ?? '';
  const classNonRetryable = classTag<NonRetryableTag>(cls, NORN.nonRetryable);
  const methods: ActivityMethodDefinition[] = [];
  const names = new Set<string>();
  for (const { method, tag: options } of methodTags<ActivityOptions>(cls, NORN.activity)) {
    const fn = (cls.prototype as Record<string, unknown>)[method];
    const nonRetryable = readMethodTag<NonRetryableTag>(fn, NORN.nonRetryable) ?? classNonRetryable;
    const name = `${prefix}${options.name ?? method}`;
    if (names.has(name)) throw new NornConfigError(`${tag.className}: activity name "${name}" is used by more than one method`);
    names.add(name);
    const recorded: ActivityOptions = { ...options };
    const errorNames = nonRetryableNames(nonRetryable);
    if (errorNames) recorded.nonRetryable = errorNames;
    methods.push({ method, name, options: recorded, nonRetryable });
  }
  if (methods.length === 0) throw new NornConfigError(`${tag.className} has no @Activity methods`);
  return { className: tag.className, prefix, inject: tag.options.inject, methods };
}

/** Reads a `@Service` class, or describes an undecorated class as a self-providing singleton. */
export function describeService(cls: Function): ServiceDefinition {
  const tag = classTag<ServiceTag>(cls, NORN.service);
  return {
    className: tag?.className ?? cls.name,
    provides: tag?.options.provides ?? (cls as InjectionKey),
    scope: tag?.options.scope ?? 'singleton',
    inject: tag?.options.inject,
  };
}
