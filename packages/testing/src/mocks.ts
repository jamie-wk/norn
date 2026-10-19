import { NornConfigError } from '@norn-ts/core';

type AnyFn = (...args: any[]) => any;

/** A workflow-safe activity reference (from `.norn/activities.ts` or `defineActivities()`). */
export interface ActivitiesRefLike<T = unknown, M extends string = string> {
  readonly kind: 'norn.activities';
  readonly prefix: string;
  readonly methods: Readonly<Record<M, unknown>>;
  readonly __type?: T;
}

export type RefInstance<R> = R extends ActivitiesRefLike<infer T, any> ? T : never;
type RefMethods<R> = R extends ActivitiesRefLike<any, infer M> ? M : never;
export type MethodFn<T, K> = K extends keyof T ? (T[K] extends AnyFn ? T[K] : never) : never;

export type ActivityImpls<R> = { [K in RefMethods<R>]?: MethodFn<RefInstance<R>, K> };

/** A recorded mock: the implementation plus every call's arguments. */
export type RecordedFn<F extends AnyFn> = F & { readonly calls: Parameters<F>[] };

export const ACTIVITY_MAP: unique symbol = Symbol.for('norn.testing.activityMap') as never;

/** Mocks keyed by method name; `R` is the activity reference they replace. */
export type MockedActivities<_R, Wrapped extends Record<string, unknown>> = Wrapped & {
  readonly [ACTIVITY_MAP]: Record<string, AnyFn>;
};

/** Anything accepted where tests pass activities: mock sets, plain `{ name: fn }` records, or lists of them. */
export type ActivitySource = { readonly [ACTIVITY_MAP]: Record<string, AnyFn> } | Record<string, AnyFn>;

export function buildMocks<R extends ActivitiesRefLike<any, any>, W extends Record<string, unknown>>(
  ref: R,
  impls: ActivityImpls<R>,
  wrap: (impl: AnyFn, method: string) => AnyFn,
): MockedActivities<R, W> {
  if (ref?.kind !== 'norn.activities') {
    throw new NornConfigError('mockActivities() expects an activity reference from .norn/activities.ts or defineActivities()');
  }
  const map: Record<string, AnyFn> = {};
  const out: Record<string, unknown> = {};
  for (const [method, impl] of Object.entries(impls as Record<string, unknown>)) {
    if (!Object.hasOwn(ref.methods, method)) {
      throw new NornConfigError(`${method} is not an activity of this reference (activities: ${Object.keys(ref.methods).join(', ')})`);
    }
    if (typeof impl !== 'function') throw new NornConfigError(`Mock for ${method} must be a function`);
    const fn = wrap(impl as AnyFn, method);
    out[method] = fn;
    map[`${ref.prefix}${method}`] = fn;
  }
  Object.defineProperty(out, ACTIVITY_MAP, { value: map, enumerable: false });
  return out as MockedActivities<R, W>;
}

function record(impl: AnyFn): AnyFn {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

/**
 * Replaces some activities of a reference with test implementations, typed from the activity
 * class. Pass the result to `createTestEnv({ activities })`. Each mock records its calls in `.calls`.
 */
export function mockActivities<R extends ActivitiesRefLike<any, any>, const I extends ActivityImpls<R>>(
  ref: R,
  impls: I,
): MockedActivities<R, { [K in keyof I]: RecordedFn<MethodFn<RefInstance<R>, K>> }> {
  return buildMocks(ref, impls, record);
}

/** Flattens mock sets and plain records into one `{ registeredName: fn }` map. */
export function activityMap(sources: ActivitySource | readonly ActivitySource[] | undefined): Record<string, AnyFn> {
  const list = sources === undefined ? [] : Array.isArray(sources) ? sources : [sources];
  const out: Record<string, AnyFn> = {};
  for (const source of list as ActivitySource[]) {
    const map = (source as { [ACTIVITY_MAP]?: Record<string, AnyFn> })[ACTIVITY_MAP] ?? (source as Record<string, AnyFn>);
    for (const [name, fn] of Object.entries(map)) {
      if (typeof fn !== 'function') throw new NornConfigError(`Activity ${name} must be a function`);
      out[name] = fn;
    }
  }
  return out;
}
