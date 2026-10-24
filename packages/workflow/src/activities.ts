import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import { NornConfigError, activityName, toActivityOptions, type ActivityOptions } from '@norn-ts/core';

/** Public method names of an activity class. */
export type ActivityMethodKey<T> = { [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never }[keyof T] & string;

/**
 * A workflow-safe reference to an activity class: registered names and options only. Its type
 * comes from `import type`, so workflow bundles never include activity code.
 */
export interface ActivitiesRef<T = unknown, M extends string = string> {
  readonly kind: 'norn.activities';
  readonly prefix: string;
  readonly methods: Readonly<Record<M, ActivityOptions>>;
  /** Phantom: the activity class instance type. */
  readonly __type?: T;
}

type OnlyMethods<S, Allowed> = { [K in Exclude<keyof S, Allowed>]: { error: `"${K & string}" is not a method of the activity class` } };

/**
 * Declares an activity reference. `norn gen` writes these into `.norn/activities.ts`:
 *
 * ```ts
 * import type { PaymentActivities } from '../activities/payment.activities.js';
 * export const payments = defineActivities<PaymentActivities>()({
 *   prefix: 'payments.',
 *   methods: { charge: { timeout: '1m', retries: 3 } },
 * });
 * ```
 */
export function defineActivities<T>() {
  return <const M extends Partial<Record<ActivityMethodKey<T>, ActivityOptions>>>(def: {
    prefix: string;
    methods: M & OnlyMethods<M, ActivityMethodKey<T>>;
  }): ActivitiesRef<T, keyof M & string> => {
    if (typeof def.prefix !== 'string') throw new NornConfigError('defineActivities: prefix must be a string');
    const methods = Object.freeze(
      Object.fromEntries(Object.entries(def.methods).map(([key, opts]) => [key, Object.freeze({ ...(opts as ActivityOptions) })])),
    );
    return Object.freeze({ kind: 'norn.activities' as const, prefix: def.prefix, methods }) as ActivitiesRef<
      T,
      keyof M & string
    >;
  };
}

/** Typed functions for each registered activity method, as seen from workflow code. */
export type ActivityProxy<R> =
  R extends ActivitiesRef<infer T, infer M>
    ? { [K in M & keyof T]: T[K] extends (...args: infer A) => infer Ret ? (...args: A) => Promise<Awaited<Ret>> : never }
    : never;

/** Per-method overrides for a proxy, applied on top of the registry's options. */
export type ActivityOverrides<R> = R extends ActivitiesRef<any, infer M> ? ActivityOptions & { methods?: Partial<Record<M, ActivityOptions>> } : never;

export { activityName };

/** Applies an override layer; its `retries` replaces an inherited `retry.maximumAttempts`, and vice versa. */
function override(options: ActivityOptions, layer: ActivityOptions): ActivityOptions {
  const next = { ...options, ...layer };
  if (layer.retries !== undefined && !layer.retry && options.retry) next.retry = { ...options.retry, maximumAttempts: undefined };
  if (layer.retry?.maximumAttempts !== undefined && layer.retries === undefined) delete next.retries;
  return next;
}

/**
 * Returns typed functions that schedule the referenced activities. Call it from workflow code,
 * typically as a class field: `private pay = useActivities(activities.payments)`.
 */
export function useActivities<R extends ActivitiesRef<any, any>>(ref: R, overrides?: ActivityOverrides<R>): ActivityProxy<R> {
  if (!ref || ref.kind !== 'norn.activities') {
    throw new NornConfigError('useActivities() needs a reference from the generated activities registry');
  }
  const { methods: perMethod, ...shared } = (overrides ?? {}) as ActivityOptions & {
    methods?: Record<string, ActivityOptions>;
  };
  const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [method, base] of Object.entries(ref.methods as Record<string, ActivityOptions>)) {
    const options = override(override(base, shared), perMethod?.[method] ?? {});
    const temporalOptions = toActivityOptions(options);
    const type = activityName(ref, method);
    const scheduled = options.local
      ? (proxyLocalActivities(temporalOptions) as Record<string, (...args: unknown[]) => Promise<unknown>>)
      : (proxyActivities(temporalOptions) as Record<string, (...args: unknown[]) => Promise<unknown>>);
    const fn = scheduled[type]!;
    proxy[method] = (...args: unknown[]) => fn(...args);
  }
  return Object.freeze(proxy) as ActivityProxy<R>;
}
