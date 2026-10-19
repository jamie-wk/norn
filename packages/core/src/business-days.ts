import { NornConfigError } from './errors.js';

export interface BusinessCalendarOptions {
  /** Non-business dates as `YYYY-MM-DD`, in the calendar's time zone. */
  holidays?: readonly string[];
  /** Weekend days, 0 = Sunday ... 6 = Saturday. Defaults to Saturday and Sunday. */
  weekend?: readonly number[];
  /** Fixed offset from UTC used to decide calendar days, in minutes. Defaults to 0 (UTC). */
  utcOffsetMinutes?: number;
}

export interface BusinessCalendar {
  isBusinessDay(at: number | Date): boolean;
  /** Adds `days` business days to `from`, keeping the time of day. `0` rolls forward to a business day. */
  addBusinessDays(from: number | Date, days: number): number;
  /** Milliseconds from `from` until `days` business days later; pass it to `sleep()` or `condition()`. */
  msUntilBusinessDays(from: number | Date, days: number): number;
}

const DAY = 86_400_000;

/**
 * A deterministic business-day calendar for timers counted in banking days, such as ACH windows.
 * Pure arithmetic only, so it is safe in workflow code; load holidays with an activity.
 */
export function businessCalendar(options: BusinessCalendarOptions = {}): BusinessCalendar {
  const weekend = new Set(options.weekend ?? [0, 6]);
  const offset = (options.utcOffsetMinutes ?? 0) * 60_000;
  if (!Number.isFinite(offset)) throw new NornConfigError('Business calendar: utcOffsetMinutes must be a finite number');
  if (weekend.size >= 7 || [...weekend].some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new NornConfigError('Business calendar: weekend must list fewer than 7 days between 0 and 6');
  }
  const holidays = new Set<string>();
  for (const h of options.holidays ?? []) {
    // Round-trip so rolled-over dates such as 2026-02-30 are rejected instead of never matching.
    const day = new Date(`${h}T00:00:00Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== h) {
      throw new NornConfigError(`Business calendar: holiday "${h}" must be a YYYY-MM-DD date`);
    }
    holidays.add(h);
  }

  const toMsValue = (at: number | Date) => (typeof at === 'number' ? at : at.getTime());
  const isBusinessDay = (at: number | Date) => {
    const local = new Date(toMsValue(at) + offset);
    if (weekend.has(local.getUTCDay())) return false;
    return !holidays.has(local.toISOString().slice(0, 10));
  };

  const addBusinessDays = (from: number | Date, days: number) => {
    if (!Number.isInteger(days) || days < 0) {
      throw new NornConfigError(`Business calendar: days must be a non-negative integer, got ${days}`);
    }
    let t = toMsValue(from);
    while (!isBusinessDay(t)) t += DAY;
    let remaining = days;
    while (remaining > 0) {
      t += DAY;
      if (isBusinessDay(t)) remaining--;
    }
    return t;
  };

  return {
    isBusinessDay,
    addBusinessDays,
    msUntilBusinessDays: (from, days) => addBusinessDays(from, days) - toMsValue(from),
  };
}
