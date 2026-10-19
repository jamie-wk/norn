import { describe, expect, it } from 'vitest';
import { NornConfigError, toMs, formatDuration } from '../src/index.ts';

describe('toMs', () => {
  it.each([
    [1500, 1500],
    ['250ms', 250],
    ['1s', 1_000],
    ['90 seconds', 90_000],
    ['1m', 60_000],
    ['5 minutes', 300_000],
    ['1h', 3_600_000],
    ['2 hours', 7_200_000],
    ['1d', 86_400_000],
    ['5 days', 432_000_000],
    ['1 day', 86_400_000],
    ['2w', 1_209_600_000],
    ['1.5h', 5_400_000],
    ['1h30m', 5_400_000],
    ['1h 30m', 5_400_000],
    ['PT1M', 60_000],
    ['PT1.5S', 1_500],
    ['P1D', 86_400_000],
    ['P1DT2H30M', 95_400_000],
    ['P2W', 1_209_600_000],
  ] as const)('converts %j to %d ms', (input, expected) => {
    expect(toMs(input)).toBe(expected);
  });

  it.each(['', 'soon', '5 fortnights', '-1s', 'P1M', 'P1Y', 'PT', '1h foo', NaN, -5, Infinity])(
    'rejects %j',
    (input) => {
      expect(() => toMs(input as never)).toThrow(NornConfigError);
    },
  );

  it('names the bad value in the error', () => {
    expect(() => toMs('5 fortnights' as never)).toThrow(/5 fortnights/);
  });
});

describe('formatDuration', () => {
  it('formats milliseconds as the Temporal SDK duration string', () => {
    expect(formatDuration(90_000)).toBe('90000ms');
    expect(formatDuration('1 day')).toBe('86400000ms');
  });
});
