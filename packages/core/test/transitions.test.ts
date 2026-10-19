import { describe, expect, it } from 'vitest';
import { transitions, NornConfigError } from '../src/index.ts';

type Status = 'authorizing' | 'submitted' | 'processing' | 'completed' | 'failed' | 'canceled';

const table = {
  authorizing: ['submitted', 'canceled', 'failed'],
  submitted: ['processing', 'completed', 'failed', 'canceled'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
} as const satisfies Record<Status, readonly Status[]>;

describe('transitions', () => {
  it('starts at the initial state with version 0', () => {
    const s = transitions(table, 'authorizing');
    expect(s.current).toBe('authorizing');
    expect(s.version).toBe(0);
  });

  it('applies legal moves and bumps the version', () => {
    const s = transitions(table, 'authorizing');
    expect(s.move('submitted')).toBe(true);
    expect(s.move('processing')).toBe(true);
    expect(s.current).toBe('processing');
    expect(s.version).toBe(2);
  });

  it('ignores illegal or out-of-order moves without throwing', () => {
    const s = transitions(table, 'submitted');
    s.move('completed');
    expect(s.move('processing')).toBe(false);
    expect(s.current).toBe('completed');
    expect(s.version).toBe(1);
  });

  it('treats a move to the current state as a no-op', () => {
    const s = transitions(table, 'submitted');
    expect(s.move('submitted')).toBe(false);
    expect(s.version).toBe(0);
  });

  it('answers can() and is()', () => {
    const s = transitions(table, 'submitted');
    expect(s.can('processing')).toBe(true);
    expect(s.can('authorizing')).toBe(false);
    expect(s.is('submitted', 'processing')).toBe(true);
    expect(s.is('completed')).toBe(false);
  });

  it('reports terminal states', () => {
    const s = transitions(table, 'processing');
    expect(s.isTerminal).toBe(false);
    s.move('failed');
    expect(s.isTerminal).toBe(true);
  });

  it('can be restored from a snapshot, for continue-as-new', () => {
    const s = transitions(table, 'authorizing');
    s.move('submitted');
    const restored = transitions(table, s.snapshot());
    expect(restored.current).toBe('submitted');
    expect(restored.version).toBe(1);
  });

  it('rejects an initial state missing from the table', () => {
    expect(() => transitions(table, 'nope' as Status)).toThrow(NornConfigError);
  });

  it('rejects tables whose targets are not states', () => {
    expect(() => transitions({ a: ['b'] } as Record<string, string[]>, 'a')).toThrow(NornConfigError);
  });
});
