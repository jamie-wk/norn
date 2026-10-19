import { NornConfigError } from './errors.js';

export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

export interface TransitionSnapshot<S extends string> {
  readonly current: S;
  readonly version: number;
}

export interface Transitions<S extends string> {
  /** The current state. */
  readonly current: S;
  /** Increments on every applied move; useful with `condition(() => s.version > before)`. */
  readonly version: number;
  /** True when the current state has no outgoing moves. */
  readonly isTerminal: boolean;
  /** Whether `next` is a legal move from the current state. */
  can(next: S): boolean;
  /** Applies the move when legal and returns whether it was applied. Illegal moves are ignored. */
  move(next: S): boolean;
  /** Whether the current state is one of `states`. */
  is(...states: S[]): boolean;
  /** A plain object to carry across continue-as-new. */
  snapshot(): TransitionSnapshot<S>;
}

/**
 * A small, deterministic state machine for workflow status. Out-of-order or duplicate events
 * (such as webhooks) are ignored instead of corrupting state.
 */
export function transitions<const T extends Record<string, readonly string[]>, S extends string = keyof T & string>(
  table: T & { readonly [K in keyof T]: readonly (keyof T & string)[] },
  initial: NoInfer<S> | TransitionSnapshot<NoInfer<S>>,
): Transitions<S> {
  const moves = table as unknown as TransitionTable<S>;
  const states = Object.keys(table) as S[];
  for (const [from, targets] of Object.entries(table) as [S, readonly S[]][]) {
    for (const to of targets) {
      if (!states.includes(to)) {
        throw new NornConfigError(`Transition table: "${from}" moves to unknown state "${to}"`);
      }
    }
  }
  let current: S = typeof initial === 'string' ? initial : initial.current;
  let version = typeof initial === 'string' ? 0 : initial.version;
  if (!states.includes(current)) {
    throw new NornConfigError(`Transition table has no state "${current}"`);
  }
  const can = (next: S) => next !== current && moves[current].includes(next);

  return {
    get current() {
      return current;
    },
    get version() {
      return version;
    },
    get isTerminal() {
      return moves[current].length === 0;
    },
    can,
    move(next) {
      if (!can(next)) return false;
      current = next;
      version++;
      return true;
    },
    is(...candidates) {
      return candidates.includes(current);
    },
    snapshot() {
      return { current, version };
    },
  };
}
