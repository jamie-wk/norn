/**
 * Decorator metadata storage that works inside Temporal's workflow sandbox.
 *
 * The sandbox freezes built-ins such as `Symbol`, so `Symbol.metadata` cannot be polyfilled there.
 * Norn instead tags the decorated method functions and classes themselves with registered symbols,
 * and walks the prototype chain to read them back. Inheritance falls out naturally: a subclass sees
 * its parents' handler declarations, and calls dispatch to the most-derived implementation.
 */

export interface MethodTag<T> {
  /** The property key of the decorated method. */
  method: string;
  tag: T;
}

/** Attaches `value` to a decorated method function under `key`. */
export function tagMethod(fn: Function, key: symbol, value: unknown): void {
  if (Object.hasOwn(fn, key)) {
    throw new Error(`Method ${fn.name || '<anonymous>'} is already decorated with ${key.description ?? 'this decorator'}`);
  }
  Object.defineProperty(fn, key, { value, enumerable: false, configurable: false, writable: false });
}

/** Reads the tag stored on a function, if any. */
export function readMethodTag<T>(fn: unknown, key: symbol): T | undefined {
  if (typeof fn !== 'function') return undefined;
  return Object.hasOwn(fn, key) ? ((fn as unknown as Record<symbol, T>)[key]) : undefined;
}

/** Attaches `value` to a decorated class under `key`, without affecting parent classes. */
export function setClassTag(cls: Function, key: symbol, value: unknown): void {
  Object.defineProperty(cls, key, { value, enumerable: false, configurable: true, writable: false });
}

/** Reads a class's own tag (not inherited). */
export function classTag<T>(cls: Function, key: symbol): T | undefined {
  return Object.hasOwn(cls, key) ? (cls as unknown as Record<symbol, T>)[key] : undefined;
}

/**
 * Lists every method tagged with `key` on `cls` and its ancestors. Most-derived declarations come
 * first; a method name is reported once, with the nearest tag in the prototype chain.
 */
export function methodTags<T>(cls: Function, key: symbol): MethodTag<T>[] {
  const out: MethodTag<T>[] = [];
  const seen = new Set<string>();
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || seen.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      const tag = descriptor && 'value' in descriptor ? readMethodTag<T>(descriptor.value, key) : undefined;
      if (tag !== undefined) {
        seen.add(name);
        out.push({ method: name, tag });
      }
    }
  }
  return out;
}

/** Registered symbols shared across Norn packages, so copies of different versions agree. */
export const NORN = Object.freeze({
  workflow: Symbol.for('norn.workflow'),
  handler: Symbol.for('norn.workflow.handler'),
  validator: Symbol.for('norn.workflow.validator'),
  activities: Symbol.for('norn.activities'),
  activity: Symbol.for('norn.activity'),
  nonRetryable: Symbol.for('norn.nonRetryable'),
  service: Symbol.for('norn.service'),
});
