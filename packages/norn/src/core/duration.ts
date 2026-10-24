import { NornConfigError } from './errors.js';

type ShortUnit = 'ms' | 's' | 'm' | 'h' | 'd' | 'w';
type LongUnit =
  | 'ms'
  | 'millisecond'
  | 'milliseconds'
  | 'sec'
  | 'secs'
  | 'second'
  | 'seconds'
  | 'min'
  | 'mins'
  | 'minute'
  | 'minutes'
  | 'hr'
  | 'hrs'
  | 'hour'
  | 'hours'
  | 'day'
  | 'days'
  | 'week'
  | 'weeks';

/**
 * A duration: milliseconds as a number, a short or long unit string (`'90s'`, `'5 days'`,
 * `'1h30m'`), or an ISO 8601 duration with days, weeks, hours, minutes or seconds (`'PT1M'`).
 */
export type Duration =
  | number
  | `${number}${ShortUnit}`
  | `${number} ${LongUnit}`
  | `${number}${ShortUnit}${number}${ShortUnit}`
  | `${number}${ShortUnit} ${number}${ShortUnit}`
  | `P${string}`;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

const PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/gy;
const ISO = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

function invalid(value: unknown, why: string): never {
  throw new NornConfigError(`Invalid duration ${JSON.stringify(value)}: ${why}`);
}

function parseIso(value: string): number {
  if (/^P.*[YM].*T|^P[^T]*[YM]/.test(value)) {
    invalid(value, 'months and years have no fixed length; use days or weeks');
  }
  const m = ISO.exec(value);
  if (!m || value === 'P' || value.endsWith('T')) invalid(value, 'not an ISO 8601 duration');
  const [, w, d, h, min, s] = m;
  return Math.round(
    Number(w ?? 0) * UNIT_MS.w! +
      Number(d ?? 0) * UNIT_MS.d! +
      Number(h ?? 0) * UNIT_MS.h! +
      Number(min ?? 0) * UNIT_MS.m! +
      Number(s ?? 0) * UNIT_MS.s!,
  );
}

function parseUnits(value: string): number {
  const text = value.trim().toLowerCase();
  if (!text) invalid(value, 'empty string');
  let total = 0;
  let index = 0;
  while (index < text.length) {
    while (text[index] === ' ') index++;
    if (index >= text.length) break;
    PART.lastIndex = index;
    const m = PART.exec(text);
    if (!m) invalid(value, 'expected a number followed by a unit, such as "5m" or "2 days"');
    const unit = UNIT_MS[m[2]!];
    if (unit === undefined) invalid(value, `unknown unit "${m[2]}"`);
    total += Number(m[1]) * unit;
    index = PART.lastIndex;
  }
  return Math.round(total);
}

/** Converts a {@link Duration} to whole milliseconds. Throws {@link NornConfigError} when invalid. */
export function toMs(duration: Duration): number {
  if (typeof duration === 'number') {
    if (!Number.isFinite(duration) || duration < 0) invalid(duration, 'must be a finite, non-negative number');
    return Math.round(duration);
  }
  if (typeof duration !== 'string') invalid(duration, 'must be a number or string');
  return duration.startsWith('P') ? parseIso(duration) : parseUnits(duration);
}

/** Normalizes a {@link Duration} to the millisecond string format the Temporal SDK accepts. */
export function formatDuration(duration: Duration): `${number}ms` {
  return `${toMs(duration)}ms`;
}
