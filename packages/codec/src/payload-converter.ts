/**
 * Norn's payload converter: Temporal's default converter, plus lossless `bigint` and TC39
 * Temporal API values.
 *
 * This module is loaded inside the workflow sandbox (via `payloadConverterPath`), so it must stay
 * deterministic and runtime-neutral: no Node APIs, no crypto, no clocks. It intentionally imports
 * nothing but `@temporalio/common`, so Node can also `require()` it directly from source.
 *
 * @module
 */
import {
  BinaryPayloadConverter,
  CompositePayloadConverter,
  METADATA_ENCODING_KEY,
  PayloadConverterError,
  UndefinedPayloadConverter,
  ValueError,
  encodingKeys,
  encodingTypes,
  str,
  u8,
  type Payload,
  type PayloadConverterWithEncoding,
} from '@temporalio/common';

/** The TC39 Temporal API types the converter round-trips. */
export const TEMPORAL_TYPES = ['Instant', 'PlainDate', 'PlainDateTime', 'ZonedDateTime', 'Duration', 'PlainTime'] as const;

export type TemporalTypeName = (typeof TEMPORAL_TYPES)[number];

/** The part of the `Temporal` namespace the converter needs: a `from(isoString)` per type. */
export type TemporalNamespace = { readonly [K in TemporalTypeName]?: { from(value: string): unknown } };

export interface NornJsonPayloadConverterOptions {
  /**
   * The Temporal API implementation used to revive Temporal values. Defaults to
   * `globalThis.Temporal`, looked up on every call, so a polyfill installed on the global later
   * is picked up. Pass a polyfill's namespace to use it without installing it globally, or
   * `null` to disable reviving Temporal values.
   */
  temporal?: TemporalNamespace | null;
}

const TAG = '$norn';
const BIGINT_TAG = 'bigint';
/** Wraps user objects that have their own `$norn` key, so they are never mistaken for tags. */
const ESCAPE_TAG = 'object';
const temporalTagByToStringTag = new Map<string, string>(TEMPORAL_TYPES.map((t) => [`[object Temporal.${t}]`, `Temporal.${t}`]));
const temporalTypeByTag = new Map<string, TemporalTypeName>(TEMPORAL_TYPES.map((t) => [`Temporal.${t}`, t]));
const objectToString = Object.prototype.toString;

type Json = Record<string, unknown>;

const isPlainRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `{ "$norn": string, "v": unknown }` with exactly those two keys. */
function readTag(obj: Json): string | undefined {
  if (!Object.hasOwn(obj, TAG) || !Object.hasOwn(obj, 'v') || typeof obj[TAG] !== 'string') return undefined;
  let count = 0;
  for (const _ in obj) if (++count > 2) return undefined;
  return obj[TAG];
}

/**
 * A `json/plain` payload converter that round-trips `bigint` and Temporal API values.
 *
 * Plain JSON values produce exactly the bytes Temporal's default `JsonPayloadConverter` produces,
 * and it decodes anything the default converter wrote, so it can replace the default on an
 * existing namespace. Special values are written as tagged objects:
 *
 * - `bigint` → `{"$norn":"bigint","v":"123"}`
 * - `Temporal.Instant` (and `PlainDate`, `PlainDateTime`, `ZonedDateTime`, `Duration`, `PlainTime`)
 *   → `{"$norn":"Temporal.Instant","v":"<toString()>"}`, revived with `Temporal.Instant.from(v)`.
 *   Values are recognized by `Symbol.toStringTag`, so polyfill instances work too.
 * - `Date` is not special-cased: it becomes an ISO string, exactly like the default converter.
 *
 * Tags only match objects with exactly the keys `$norn` and `v`. User objects that have a `$norn`
 * key are escaped on write (`{"$norn":"object","v":{...}}`), and objects with an unknown tag are
 * left as they are on read.
 */
export class NornJsonPayloadConverter implements PayloadConverterWithEncoding {
  readonly encodingType = encodingTypes.METADATA_ENCODING_JSON;
  readonly #temporal: TemporalNamespace | null | undefined;

  constructor(options: NornJsonPayloadConverterOptions = {}) {
    this.#temporal = options.temporal;
  }

  toPayload(value: unknown): Payload | undefined {
    if (value === undefined) return undefined;
    const escapes = new WeakSet<object>();
    function replacer(this: unknown, key: string, current: unknown): unknown {
      const raw = (this as Json)[key];
      if (typeof raw === 'bigint') return { [TAG]: BIGINT_TAG, v: raw.toString() };
      if (raw !== null && typeof raw === 'object') {
        const tag = temporalTagByToStringTag.get(objectToString.call(raw));
        if (tag) return { [TAG]: tag, v: String(raw) };
      }
      if (isPlainRecord(current) && Object.hasOwn(current, TAG) && !(key === 'v' && escapes.has(this as object))) {
        const wrapper = { [TAG]: ESCAPE_TAG, v: current };
        escapes.add(wrapper);
        return wrapper;
      }
      return current;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value, replacer);
    } catch {
      return undefined;
    }
    if (json === undefined) return undefined;
    return { metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON }, data: u8(json) };
  }

  fromPayload<T>(payload: Payload): T {
    if (payload.data === undefined || payload.data === null) throw new ValueError('Got payload with no data');
    const text = str(payload.data);
    const parsed: unknown = JSON.parse(text);
    // Fast path: nothing tagged (also catches a `$norn` spelling).
    return (text.includes('norn') ? this.#revive(parsed) : parsed) as T;
  }

  #revive(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = this.#revive(value[i]);
      return value;
    }
    const obj = value as Json;
    const tag = readTag(obj);
    if (tag !== undefined) {
      const v = obj.v;
      if (tag === BIGINT_TAG && typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
      if (tag === ESCAPE_TAG && isPlainRecord(v)) return this.#reviveChildren(v);
      const type = temporalTypeByTag.get(tag);
      if (type && typeof v === 'string') return this.#reviveTemporal(type, v);
    }
    return this.#reviveChildren(obj);
  }

  /** Revives values in place; JSON.parse makes `__proto__` an own data property, which assignment keeps. */
  #reviveChildren(obj: Json): Json {
    for (const key of Object.keys(obj)) obj[key] = this.#revive(obj[key]);
    return obj;
  }

  #reviveTemporal(type: TemporalTypeName, v: string): unknown {
    const ns =
      this.#temporal === undefined ? (globalThis as { Temporal?: TemporalNamespace }).Temporal : (this.#temporal ?? undefined);
    const ctor = ns?.[type];
    if (!ctor || typeof ctor.from !== 'function') {
      throw new PayloadConverterError(
        `Payload contains a Temporal.${type} value, but globalThis.Temporal is not available in this runtime. ` +
          'Decode it on a runtime with the Temporal API, or provide an implementation via NornJsonPayloadConverter({ temporal }).',
      );
    }
    try {
      return ctor.from(v);
    } catch (error) {
      throw new PayloadConverterError(`Payload contains an invalid Temporal.${type} value`, error);
    }
  }
}

/**
 * The converter loaded via `payloadConverterPath` (Temporal requires this exact export name):
 * `undefined` → `binary/null`, `Uint8Array` → `binary/plain`, everything else → Norn JSON.
 */
export const payloadConverter = new CompositePayloadConverter(
  new UndefinedPayloadConverter(),
  new BinaryPayloadConverter(),
  new NornJsonPayloadConverter(),
);
