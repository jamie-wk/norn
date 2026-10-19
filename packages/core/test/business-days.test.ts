import { describe, expect, it } from 'vitest';
import { businessCalendar, NornConfigError } from '../src/index.ts';

const at = (iso: string) => Date.parse(iso);

describe('businessCalendar', () => {
  const cal = businessCalendar({ holidays: ['2026-11-26', '2026-12-25'] });

  it('treats weekends and holidays as non-business days', () => {
    expect(cal.isBusinessDay(at('2026-10-19T12:00:00Z'))).toBe(true); // Monday
    expect(cal.isBusinessDay(at('2026-10-24T12:00:00Z'))).toBe(false); // Saturday
    expect(cal.isBusinessDay(at('2026-10-25T12:00:00Z'))).toBe(false); // Sunday
    expect(cal.isBusinessDay(at('2026-11-26T12:00:00Z'))).toBe(false); // holiday
  });

  it('adds business days, skipping weekends and holidays, keeping the time of day', () => {
    // Friday + 1 business day = Monday
    expect(cal.addBusinessDays(at('2026-10-23T15:00:00Z'), 1)).toBe(at('2026-10-26T15:00:00Z'));
    // Wednesday before Thanksgiving + 1 = Friday
    expect(cal.addBusinessDays(at('2026-11-25T09:00:00Z'), 1)).toBe(at('2026-11-27T09:00:00Z'));
    // Monday + 5 business days = next Monday
    expect(cal.addBusinessDays(at('2026-10-19T00:00:00Z'), 5)).toBe(at('2026-10-26T00:00:00Z'));
  });

  it('rolls a weekend start forward to the next business day for n = 0', () => {
    expect(cal.addBusinessDays(at('2026-10-24T10:00:00Z'), 0)).toBe(at('2026-10-26T10:00:00Z'));
    expect(cal.addBusinessDays(at('2026-10-20T10:00:00Z'), 0)).toBe(at('2026-10-20T10:00:00Z'));
  });

  it('returns the wait in milliseconds for workflow timers', () => {
    const from = at('2026-10-23T15:00:00Z');
    expect(cal.msUntilBusinessDays(from, 1)).toBe(3 * 86_400_000);
  });

  it('respects a time zone offset when deciding the calendar day', () => {
    const ny = businessCalendar({ utcOffsetMinutes: -300 });
    // 2026-10-24T02:00Z is still Friday 21:00 in New York
    expect(ny.isBusinessDay(at('2026-10-24T02:00:00Z'))).toBe(true);
  });

  it('supports custom weekends', () => {
    const fridaySaturday = businessCalendar({ weekend: [5, 6] });
    expect(fridaySaturday.isBusinessDay(at('2026-10-23T12:00:00Z'))).toBe(false);
    expect(fridaySaturday.isBusinessDay(at('2026-10-25T12:00:00Z'))).toBe(true);
  });

  it('rejects malformed holidays and negative day counts', () => {
    expect(() => businessCalendar({ holidays: ['11/26/2026'] })).toThrow(NornConfigError);
    expect(() => businessCalendar({ holidays: ['2026-02-30'] })).toThrow(NornConfigError);
    expect(() => businessCalendar({ holidays: ['2026-13-01'] })).toThrow(NornConfigError);
    expect(() => businessCalendar({ holidays: ['2027-02-29'] })).toThrow(NornConfigError);
    expect(() => businessCalendar({ utcOffsetMinutes: Number.NaN })).toThrow(NornConfigError);
    expect(() => businessCalendar({ utcOffsetMinutes: Infinity })).toThrow(NornConfigError);
    expect(businessCalendar({ holidays: ['2028-02-29'] }).isBusinessDay(at('2028-02-29T12:00:00Z'))).toBe(false);
    expect(() => cal.addBusinessDays(at('2026-10-19T00:00:00Z'), -1)).toThrow(NornConfigError);
    expect(() => businessCalendar({ weekend: [0, 1, 2, 3, 4, 5, 6] })).toThrow(NornConfigError);
  });
});
