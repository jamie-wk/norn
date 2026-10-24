import { describe, expect, it } from 'vitest';
import { isSearchAttributeValue } from '../../src/core/index.ts';

describe('isSearchAttributeValue', () => {
  it('accepts values of the declared type', () => {
    expect(isSearchAttributeValue('keyword', 'a')).toBe(true);
    expect(isSearchAttributeValue('int', 3)).toBe(true);
    expect(isSearchAttributeValue('double', 1.5)).toBe(true);
    expect(isSearchAttributeValue('bool', false)).toBe(true);
    expect(isSearchAttributeValue('datetime', new Date())).toBe(true);
    expect(isSearchAttributeValue('keywordList', ['a', 'b'])).toBe(true);
  });

  it('rejects values Temporal cannot store as that type', () => {
    expect(isSearchAttributeValue('text', 1)).toBe(false);
    expect(isSearchAttributeValue('int', 1.5)).toBe(false);
    expect(isSearchAttributeValue('double', Number.NaN)).toBe(false);
    expect(isSearchAttributeValue('double', Infinity)).toBe(false);
    expect(isSearchAttributeValue('datetime', new Date('nope'))).toBe(false);
    expect(isSearchAttributeValue('keywordList', ['a', 1])).toBe(false);
  });
});
