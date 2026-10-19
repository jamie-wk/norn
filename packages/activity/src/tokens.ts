import { NornConfigError } from '@norn/core';

/** A dependency key for values that are not classes, such as interfaces or configuration. */
export interface Token<T = unknown> {
  readonly kind: 'norn.token';
  readonly name: string;
  /** Phantom: the provided value type. */
  readonly __type?: T;
}

/** Anything the container can resolve: a class or a {@link Token}. */
export type InjectionKey<T = unknown> = Token<T> | (abstract new (...args: any[]) => T);

export type Resolved<K> = K extends Token<infer T> ? T : K extends abstract new (...args: any[]) => infer I ? I : never;

/**
 * Creates a token for an interface or value. Give it the same name as the interface so
 * constructor parameter types read naturally:
 *
 * ```ts
 * export interface TransferService { send(t: Transfer): Promise<TransferId> }
 * export const TransferService = token<TransferService>('TransferService');
 * ```
 */
export function token<T>(name: string): Token<T> {
  if (typeof name !== 'string' || name.trim() === '') throw new NornConfigError('token() needs a non-empty name');
  return Object.freeze({ kind: 'norn.token' as const, name });
}

export function isToken(value: unknown): value is Token {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'norn.token';
}

export function keyName(key: unknown): string {
  if (isToken(key)) return key.name;
  if (typeof key === 'function') return key.name || '<anonymous class>';
  return String(key);
}

export function isInjectionKey(value: unknown): value is InjectionKey {
  return isToken(value) || typeof value === 'function';
}
