import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import { NornConfigError, toActivityOptions, type ActivityOptions } from '../core/index.js';

/** Public method names of an activity class. */
export type ActivityMethodKey<T> = { [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never }[keyof T] & string;

/** Applies an override layer; its `retries` replaces an inherited `retry.maximumAttempts`, and vice versa. */
function override(options: ActivityOptions, layer: ActivityOptions): ActivityOptions {
  const next = { ...options, ...layer };
  if (layer.retries !== undefined && !layer.retry && options.retry) next.retry = { ...options.retry, maximumAttempts: undefined };
  if (layer.retry?.maximumAttempts !== undefined && layer.retries === undefined) delete next.retries;
  return next;
}

export type ActivityCallOptions<T> = ActivityOptions & {
  /** Options for single methods, applied on top of the shared ones. */
  methods?: Partial<Record<ActivityMethodKey<T>, ActivityOptions>>;
};

/**
 * Typed functions that schedule the activities of class `T`, registered on the worker under
 * `namespace`: `useActivities<PaymentActivities>('payments', { timeout: '30s' })` schedules
 * `payments.charge`. Import `T` with `import type`, so no activity code reaches the workflow.
 */
export function useActivities<T>(namespace: string, options?: ActivityCallOptions<T>): ActivitiesOf<T> {
  return byNamespace(namespace, options as ActivityCallOptions<unknown>) as ActivitiesOf<T>;
}

/** Typed functions for each method of an activity class `T`, as seen from workflow code. */
export type ActivitiesOf<T> = {
  [K in ActivityMethodKey<T>]: T[K] extends (...args: infer A) => infer Ret ? (...args: A) => Promise<Awaited<Ret>> : never;
};

/** `useActivities<T>('payments')`: schedules `payments.<method>`; the worker registers the same names. */
function byNamespace(namespace: string, options: (ActivityOptions & { methods?: Partial<Record<string, ActivityOptions>> }) | undefined): unknown {
  if (typeof namespace !== 'string') throw new NornConfigError('useActivities: the namespace must be a non-empty string');
  if (namespace === '') throw new NornConfigError('useActivities: the namespace must be a non-empty string');
  const { methods: perMethod, ...shared } = options ?? {};
  const cache = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy({}, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      let fn = cache.get(method);
      if (!fn) {
        const merged = override(shared, perMethod?.[method] ?? {});
        const temporalOptions = toActivityOptions(merged);
        const scheduled = (merged.local ? proxyLocalActivities(temporalOptions) : proxyActivities(temporalOptions)) as Record<string, (...args: unknown[]) => Promise<unknown>>;
        fn = scheduled[`${namespace}.${method}`]!;
        cache.set(method, fn);
      }
      return fn;
    },
  });
}
